"""排班服務 API（含帳號、班表文件持久化與管理後台）。

啟動：python -m uvicorn app.api.main:app --host 0.0.0.0 --port 8137
首次啟動會建立管理員帳號 admin / admin123（請立即在管理後台改密碼）。
"""
from __future__ import annotations

import json
import shutil
import tempfile
import threading
import time
import uuid
from pathlib import Path
from typing import Any, Optional

from fastapi import Depends, FastAPI, File, Form, HTTPException, Request, Response, UploadFile
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from starlette.background import BackgroundTask

from ..engine.checker import check as check_roster
from ..engine.lint import lint
from ..engine.schema import Problem
from ..engine.solver import solve
from . import auth, db
from .xlsx_export import build_xlsx
from .xlsx_import import parse_grid, parse_staff

ROOT = Path(__file__).resolve().parent.parent.parent
TEMPLATE_DIR = ROOT / "app" / "templates"
WEB_DIR = ROOT / "app" / "web"

START_TIME = time.time()
VERSION = "0.4.0"

# 對外公開（HTTPS）時設環境變數 PUBLIC_HTTPS=1，session cookie 會加上 Secure 旗標，
# 避免憑證在非加密連線中被攔截。本機使用時保持未設定即可。
import os
SECURE_COOKIE = os.environ.get("PUBLIC_HTTPS", "").strip() in ("1", "true", "yes")

# 共用展示帳號（帳密會寫給審核者），禁止自行改密碼，避免一人改掉後其他人無法登入。
# 以逗號分隔；設為空字串即停用此保護。
DEMO_USERS = {u.strip() for u in os.environ.get("DEMO_USERS", "demo,trial").split(",") if u.strip()}

# 求解資源上限：schema 內的 solver 設定來自使用者，一律在伺服器端夾到此範圍內
SOLVE_MAX_SECONDS = float(os.environ.get("SOLVE_MAX_SECONDS", "120"))
SOLVE_MAX_WORKERS = max(1, min(int(os.environ.get("SOLVE_MAX_WORKERS", "8")), os.cpu_count() or 8))
DIAGNOSE_MAX_PROBE_SECONDS = 10.0
DIAGNOSE_MAX_TOTAL_SECONDS = 180.0
JOB_RETENTION_SECONDS = 3600   # 完成的工作在記憶體保留多久，逾時改從資料庫取回

app = FastAPI(title="排班平台", version=VERSION)
rate_limiter = auth.LoginRateLimiter()
solve_slots = threading.Semaphore(2)   # 同時最多 2 個求解


@app.on_event("startup")
def startup():
    db.init_db()
    db.mark_stale_jobs()
    if db.user_count() == 0:
        db.create_user("admin", auth.hash_password("admin123"),
                       display_name="系統管理員", role="admin", must_change=True)
        print("已建立初始管理員帳號 admin / admin123，請立即登入管理後台修改密碼")

    # 對外公開模式的安全檢查
    if SECURE_COOKIE:
        weak = [u["username"] for u in db.list_users()
                if u["active"] and u["must_change_password"]]
        if weak:
            print("=" * 64)
            print("警告：以下帳號仍在使用預設或已重設的密碼，但服務已設為對外公開：")
            print("      " + "、".join(weak))
            print("      請立即登入更換密碼，否則任何人都可能取得存取權。")
            print("=" * 64)


# ---------- 認證 ----------

def session_user(request: Request) -> dict:
    """已登入即可（含尚未更換預設密碼的帳號），僅供查詢身分與改密碼使用。"""
    token = request.cookies.get("session")
    if not token:
        raise HTTPException(status_code=401, detail="未登入")
    row = db.get_session_user(token)
    if row is None:
        raise HTTPException(status_code=401, detail="登入已失效")
    return dict(row)


def current_user(user: dict = Depends(session_user)) -> dict:
    # 強制改密碼必須在伺服器端擋下，否則知道預設密碼的人可直接呼叫 API
    if user["must_change_password"]:
        raise HTTPException(status_code=403, detail="請先變更密碼後再繼續使用")
    return user


def _user_info(user) -> dict:
    return {"username": user["username"], "displayName": user["display_name"],
            "role": user["role"], "mustChangePassword": bool(user["must_change_password"]),
            "isDemo": user["username"] in DEMO_USERS}


def admin_user(user: dict = Depends(current_user)) -> dict:
    if user["role"] != "admin":
        raise HTTPException(status_code=403, detail="需要管理員權限")
    return user


@app.post("/api/auth/login")
def login(body: dict, request: Request, response: Response):
    ip = request.client.host if request.client else "?"
    if rate_limiter.blocked(ip):
        raise HTTPException(status_code=429, detail="嘗試次數過多，請 15 分鐘後再試")
    username = (body.get("username") or "").strip()
    password = body.get("password") or ""
    row = db.get_user_by_username(username)
    if row is None or not row["active"] or not auth.verify_password(password, row["password_hash"]):
        rate_limiter.record_failure(ip)
        raise HTTPException(status_code=401, detail="帳號或密碼錯誤")
    rate_limiter.reset(ip)
    token = auth.new_session_token()
    db.create_session(token, row["id"])
    response.set_cookie("session", token, httponly=True, samesite="lax",
                        secure=SECURE_COOKIE, max_age=db.SESSION_TTL)
    return _user_info(row)


@app.post("/api/auth/logout")
def logout(request: Request, response: Response):
    token = request.cookies.get("session")
    if token:
        db.delete_session(token)
    response.delete_cookie("session")
    return {"ok": True}


@app.get("/api/auth/me")
def me(user: dict = Depends(session_user)):
    return _user_info(user)


@app.post("/api/auth/change-password")
def change_password(body: dict, request: Request, user: dict = Depends(session_user)):
    if user["username"] in DEMO_USERS:
        raise HTTPException(status_code=403, detail="展示帳號為多人共用，無法變更密碼")
    old = body.get("oldPassword") or ""
    new = body.get("newPassword") or ""
    if len(new) < 8:
        raise HTTPException(status_code=422, detail="新密碼至少 8 個字元")
    if not auth.verify_password(old, user["password_hash"]):
        # 用 400 而非 401：前端遇到 401 會當作登入失效而跳回登入頁
        raise HTTPException(status_code=400, detail="目前密碼錯誤")
    db.update_user_password(user["id"], auth.hash_password(new), must_change=False)
    # 其他裝置上的登入一律失效，只保留目前這個
    db.delete_user_sessions(user["id"], keep_token=request.cookies.get("session"))
    return {"ok": True}


# ---------- 班表文件 ----------

def _owned_schedule(schedule_id: int, user: dict):
    row = db.get_schedule(schedule_id)
    if row is None:
        raise HTTPException(status_code=404, detail="查無此班表")
    if row["owner_id"] != user["id"] and user["role"] != "admin":
        raise HTTPException(status_code=403, detail="無權存取此班表")
    return row


@app.get("/api/schedules")
def my_schedules(user: dict = Depends(current_user)):
    return db.list_schedules(owner_id=user["id"])


@app.post("/api/schedules")
def create_schedule(body: dict, user: dict = Depends(current_user)):
    schema = body.get("schema")
    if not schema:
        raise HTTPException(status_code=422, detail="缺少 schema")
    name = body.get("name") or schema.get("meta", {}).get("name") or "未命名班表"
    sid = db.create_schedule(user["id"], name, schema)
    return {"id": sid, "name": name}


@app.get("/api/schedules/{schedule_id}")
def get_schedule(schedule_id: int, user: dict = Depends(current_user)):
    row = _owned_schedule(schedule_id, user)
    return {
        "id": row["id"], "name": row["name"],
        "schema": json.loads(row["schema_json"]),
        "result": json.loads(row["result_json"]) if row["result_json"] else None,
        "updatedAt": row["updated_at"],
    }


@app.put("/api/schedules/{schedule_id}")
def save_schedule(schedule_id: int, body: dict, user: dict = Depends(current_user)):
    _owned_schedule(schedule_id, user)
    schema = body.get("schema")
    name = body.get("name")
    if schema and not name:
        name = schema.get("meta", {}).get("name")
    db.update_schedule(schedule_id, name=name, schema=schema,
                       result=body.get("result"))
    return {"ok": True}


@app.delete("/api/schedules/{schedule_id}")
def remove_schedule(schedule_id: int, user: dict = Depends(current_user)):
    _owned_schedule(schedule_id, user)
    db.delete_schedule(schedule_id)
    return {"ok": True}


# ---------- 求解 ----------

_jobs: dict[str, dict[str, Any]] = {}
_jobs_lock = threading.Lock()


def _run_job(job_id: str, problem: Problem, user_id: Optional[int], schedule_id: Optional[int]):
    def progress(msg: str):
        with _jobs_lock:
            if job_id in _jobs:
                _jobs[job_id]["progress"] = msg

    progress("等待求解資源…")
    payload: dict = {"status": "error", "error": "求解過程發生未預期的錯誤"}
    try:
        with solve_slots:
            try:
                result = solve(problem, progress_cb=progress)
                payload = result.model_dump(mode="json", by_alias=True)
                db.record_job_end(job_id, "done", result.status,
                                  result.objective_value, result.solve_seconds)
                if schedule_id is not None and result.status in ("optimal", "feasible"):
                    db.update_schedule(schedule_id, result=payload)
            except Exception as exc:
                payload = {"status": "error", "error": str(exc)}
                db.record_job_end(job_id, "error", None, None, None)
    finally:
        # 無論如何都要結束工作，否則該使用者會一直被「已有求解進行中」擋住
        with _jobs_lock:
            _jobs[job_id]["state"] = "done"
            _jobs[job_id]["result"] = payload
            _jobs[job_id]["finished_at"] = time.time()


def _clamp_solver(problem: Problem):
    """schema 的求解設定由使用者提供，夾到伺服器上限內，避免單一請求長期佔住求解資源。"""
    cfg = problem.solver
    cfg.time_limit_seconds = min(max(cfg.time_limit_seconds, 1.0), SOLVE_MAX_SECONDS)
    cfg.num_workers = min(max(cfg.num_workers, 1), SOLVE_MAX_WORKERS)
    cfg.diagnose_probe_seconds = min(max(cfg.diagnose_probe_seconds, 1.0), DIAGNOSE_MAX_PROBE_SECONDS)
    cfg.diagnose_budget_seconds = min(max(cfg.diagnose_budget_seconds, 1.0), DIAGNOSE_MAX_TOTAL_SECONDS)


def _submit(problem: Problem, user_id: Optional[int], schedule_id: Optional[int]):
    _clamp_solver(problem)
    job_id = uuid.uuid4().hex[:12]
    now = time.time()
    with _jobs_lock:
        # 清掉早已完成的工作，避免結果無限累積在記憶體
        for jid in [k for k, j in _jobs.items()
                    if j["state"] == "done" and now - j.get("finished_at", now) > JOB_RETENTION_SECONDS]:
            del _jobs[jid]
        if any(j["state"] == "running" and j["user_id"] == user_id for j in _jobs.values()):
            raise HTTPException(status_code=429, detail="你已有一份班表正在計算，請等它完成後再試")
        _jobs[job_id] = {"state": "running", "progress": "排入佇列…", "result": None,
                         "user_id": user_id}
    db.record_job_start(job_id, user_id, schedule_id)
    threading.Thread(target=_run_job, args=(job_id, problem, user_id, schedule_id), daemon=True).start()
    return {"jobId": job_id}


@app.post("/api/solve")
def submit_solve(body: dict, user: dict = Depends(current_user)):
    try:
        problem = Problem.model_validate(body)
    except Exception as exc:
        raise HTTPException(status_code=422, detail=f"Schema 驗證失敗: {exc}")
    return _submit(problem, user["id"], None)


@app.post("/api/schedules/{schedule_id}/solve")
def solve_schedule(schedule_id: int, body: dict, user: dict = Depends(current_user)):
    _owned_schedule(schedule_id, user)
    schema = body.get("schema")
    if schema:  # 求解前順手存檔
        db.update_schedule(schedule_id, schema=schema,
                           name=schema.get("meta", {}).get("name"))
    else:
        schema = json.loads(db.get_schedule(schedule_id)["schema_json"])
    try:
        problem = Problem.model_validate(schema)
    except Exception as exc:
        raise HTTPException(status_code=422, detail=f"Schema 驗證失敗: {exc}")
    return _submit(problem, user["id"], schedule_id)


@app.get("/api/jobs/{job_id}")
def get_job(job_id: str, user: dict = Depends(current_user)):
    # 查不到與不是自己的工作一律回 404，不透露工作是否存在
    with _jobs_lock:
        job = _jobs.get(job_id)
    if job is not None:
        if job["user_id"] != user["id"] and user["role"] != "admin":
            raise HTTPException(status_code=404, detail="查無此工作")
        return {"state": job["state"], "progress": job["progress"], "result": job["result"]}

    # 記憶體中沒有：可能伺服器已重啟或結果已過保留期。改查資料庫，若當時已完成則從班表取回結果
    row = db.get_job(job_id)
    if row is None or (row["user_id"] != user["id"] and user["role"] != "admin"):
        raise HTTPException(status_code=404, detail="查無此工作")
    if row["status"] in ("running", "interrupted"):
        return {"state": "done", "progress": "",
                "result": {"status": "error",
                           "error": "伺服器在計算期間重新啟動，請再按一次開始排班"}}
    if (row["status"] == "done" and row["result_status"] in ("optimal", "feasible")
            and row["schedule_id"]):
        sch = db.get_schedule(row["schedule_id"])
        if sch is not None and sch["result_json"]:
            return {"state": "done", "progress": "", "result": json.loads(sch["result_json"])}
    return {"state": "done", "progress": "",
            "result": {"status": "error", "error": "結果已不可用，請重新排班"}}


@app.post("/api/validate")
def validate_schema(body: dict, user: dict = Depends(current_user)):
    """格式驗證 + 設定健檢（找出會讓規則默默失效的設定錯誤）。"""
    try:
        problem = Problem.model_validate(body)
    except Exception as exc:
        return {"valid": False, "detail": str(exc), "issues": []}
    try:
        issues = [i.to_dict() for i in lint(problem)]
    except Exception:
        issues = []
    return {
        "valid": True,
        "issues": issues,
        "errorCount": sum(1 for i in issues if i["level"] == "error"),
    }


@app.post("/api/check")
def check_schedule(body: dict, user: dict = Depends(current_user)):
    """檢核一份既有班表違反了哪些硬性規則（不求解，毫秒級）。"""
    schema = body.get("schema")
    assignments = body.get("assignments")
    if not schema or assignments is None:
        raise HTTPException(status_code=422, detail="需要 schema 與 assignments")
    try:
        problem = Problem.model_validate(schema)
    except Exception as exc:
        raise HTTPException(status_code=422, detail=f"設定檔驗證失敗: {exc}")
    try:
        violations = check_roster(problem, assignments)
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"檢核失敗: {exc}")
    by_block: dict[str, int] = {}
    for v in violations:
        by_block[v.block] = by_block.get(v.block, 0) + 1
    return {
        "violations": [v.to_dict() for v in violations],
        "total": len(violations),
        "byBlock": by_block,
        "checkedDays": len({a["date"] if isinstance(a, dict) else a for a in
                            [x.get("date") for x in assignments]}),
        "checkedAssignments": len(assignments),
    }


@app.post("/api/export/xlsx")
def export_xlsx(body: dict, user: dict = Depends(current_user)):
    problem = body.get("problem")
    result = body.get("result")
    if not problem or not result:
        raise HTTPException(status_code=422, detail="需要 problem 與 result")
    try:
        data = build_xlsx(problem, result)
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"匯出失敗: {exc}")
    return Response(
        content=data,
        media_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        headers={"Content-Disposition": 'attachment; filename="schedule.xlsx"'},
    )


# ---------- 模板 ----------

@app.post("/api/import/xlsx")
async def import_xlsx(kind: str = Form(...), file: UploadFile = File(...),
                      year: int = Form(2026), month: int = Form(1),
                      user: dict = Depends(current_user)):
    """kind: staff | preassign | history"""
    if not file.filename.lower().endswith((".xlsx", ".xlsm")):
        raise HTTPException(status_code=422, detail="請上傳 .xlsx 檔案（舊版 .xls 請先另存新檔）")
    content = await file.read()
    if len(content) > 8 * 1024 * 1024:
        raise HTTPException(status_code=413, detail="檔案過大（上限 8 MB）")
    try:
        if kind == "staff":
            result = parse_staff(content)
        elif kind in ("preassign", "history"):
            result = parse_grid(content, year, month, kind)
        else:
            raise HTTPException(status_code=422, detail="未知的匯入類型")
    except HTTPException:
        raise
    except Exception as exc:
        raise HTTPException(status_code=422, detail=f"檔案解析失敗：{exc}")
    if "error" in result:
        raise HTTPException(status_code=422, detail=result["error"])
    return result


@app.post("/api/demo")
def create_demo(user: dict = Depends(current_user)):
    """建立一份已排好的示範班表，讓首次使用者立刻看到完整成果。"""
    f = TEMPLATE_DIR / "_demo_solved.json"
    if not f.exists():
        raise HTTPException(status_code=404, detail="示範資料不存在")
    payload = json.loads(f.read_text(encoding="utf-8"))
    sid = db.create_schedule(user["id"], payload["schema"]["meta"]["name"], payload["schema"])
    db.update_schedule(sid, result=payload["result"])
    return {"id": sid, "name": payload["schema"]["meta"]["name"]}


@app.get("/api/templates")
def list_templates(user: dict = Depends(current_user)):
    out = []
    for f in sorted(TEMPLATE_DIR.glob("*.json")):
        if f.name.startswith("_"):
            continue
        try:
            data = json.loads(f.read_text(encoding="utf-8"))
            out.append({
                "id": f.stem,
                "name": data.get("meta", {}).get("name", f.stem),
                "description": data.get("meta", {}).get("description", ""),
            })
        except Exception:
            continue
    return out


@app.get("/api/templates/{template_id}")
def get_template(template_id: str, user: dict = Depends(current_user)):
    f = TEMPLATE_DIR / f"{template_id}.json"
    if not f.exists():
        raise HTTPException(status_code=404, detail="查無此模板")
    return json.loads(f.read_text(encoding="utf-8"))


# ---------- 管理後台 ----------

@app.get("/api/admin/stats")
def admin_stats(user: dict = Depends(admin_user)):
    with _jobs_lock:
        running = sum(1 for j in _jobs.values() if j["state"] == "running")
    return {
        "version": VERSION,
        "uptimeSeconds": time.time() - START_TIME,
        "userCount": db.user_count(),
        "scheduleCount": db.schedule_count(),
        "jobCount": db.job_count(),
        "runningJobs": running,
        "dbSizeBytes": db.DB_PATH.stat().st_size if db.DB_PATH.exists() else 0,
    }


@app.get("/api/admin/users")
def admin_list_users(user: dict = Depends(admin_user)):
    return [{"id": r["id"], "username": r["username"], "displayName": r["display_name"],
             "role": r["role"], "active": bool(r["active"]),
             "createdAt": r["created_at"]} for r in db.list_users()]


@app.post("/api/admin/users")
def admin_create_user(body: dict, user: dict = Depends(admin_user)):
    username = (body.get("username") or "").strip()
    password = body.get("password") or ""
    if not username or len(password) < 8:
        raise HTTPException(status_code=422, detail="帳號必填，密碼至少 8 字元")
    if db.get_user_by_username(username):
        raise HTTPException(status_code=409, detail="帳號已存在")
    uid = db.create_user(username, auth.hash_password(password),
                         display_name=body.get("displayName") or "",
                         role="admin" if body.get("role") == "admin" else "unit",
                         must_change=True)
    return {"id": uid}


@app.post("/api/admin/users/{user_id}/reset-password")
def admin_reset_password(user_id: int, body: dict, user: dict = Depends(admin_user)):
    password = body.get("password") or ""
    if len(password) < 8:
        raise HTTPException(status_code=422, detail="密碼至少 8 字元")
    if db.get_user(user_id) is None:
        raise HTTPException(status_code=404, detail="查無使用者")
    db.update_user_password(user_id, auth.hash_password(password), must_change=True)
    db.delete_user_sessions(user_id)
    return {"ok": True}


@app.post("/api/admin/users/{user_id}/toggle")
def admin_toggle_user(user_id: int, user: dict = Depends(admin_user)):
    row = db.get_user(user_id)
    if row is None:
        raise HTTPException(status_code=404, detail="查無使用者")
    if row["id"] == user["id"]:
        raise HTTPException(status_code=422, detail="不能停用自己")
    db.set_user_active(user_id, not row["active"])
    return {"active": not row["active"]}


@app.get("/api/admin/schedules")
def admin_list_schedules(user: dict = Depends(admin_user)):
    return db.list_schedules()


@app.delete("/api/admin/schedules/{schedule_id}")
def admin_delete_schedule(schedule_id: int, user: dict = Depends(admin_user)):
    if db.get_schedule(schedule_id) is None:
        raise HTTPException(status_code=404, detail="查無此班表")
    db.delete_schedule(schedule_id)
    return {"ok": True}


@app.get("/api/admin/jobs")
def admin_list_jobs(limit: int = 100, user: dict = Depends(admin_user)):
    return db.list_jobs(limit=min(limit, 500))


@app.get("/api/admin/backup")
def admin_backup(user: dict = Depends(admin_user)):
    """以 SQLite 線上備份 API 產生一致性快照後下載。"""
    import sqlite3
    tmp = Path(tempfile.gettempdir()) / f"scheduler-backup-{uuid.uuid4().hex}.db"
    src = sqlite3.connect(db.DB_PATH)
    dst = sqlite3.connect(tmp)
    with dst:
        src.backup(dst)
    src.close()
    dst.close()
    filename = f"scheduler-backup-{time.strftime('%Y%m%d-%H%M%S')}.db"
    # 快照含所有密碼雜湊，送出後立即刪除，不留在暫存目錄
    return FileResponse(tmp, filename=filename, media_type="application/octet-stream",
                        background=BackgroundTask(tmp.unlink, missing_ok=True))


# ---------- 靜態前端 ----------

@app.get("/")
def index():
    return FileResponse(WEB_DIR / "index.html")


@app.get("/admin")
def admin_page():
    return FileResponse(WEB_DIR / "admin.html")


app.mount("/static", StaticFiles(directory=str(WEB_DIR)), name="static")
