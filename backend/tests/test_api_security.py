"""API 安全性回歸測試：強制改密碼、展示帳號、session 失效、求解資源上限與工作歸屬。

求解本身以假的 solve 取代，整個檔案數秒內跑完；資料庫改用暫存目錄，不動到 data/。
"""
import copy
import json
import tempfile
import threading
import time
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from app.api import auth, db, main
from app.engine.schema import Problem, SolveResult
from app.engine.solver import diagnose

ROOT = Path(__file__).resolve().parent.parent
EXAMPLE = json.loads((ROOT / "spec" / "examples" / "nursing-3shift-example.json").read_text(encoding="utf-8"))


class FakeSolver:
    """取代 main.solve：記錄收到的 problem，可選擇卡住直到 release()。"""

    def __init__(self):
        self.problems: list[Problem] = []
        self.gate = threading.Event()
        self.gate.set()

    def __call__(self, problem, progress_cb=None):
        self.problems.append(problem)
        self.gate.wait(timeout=10)
        return SolveResult(status="feasible", objective_value=1.0, solve_seconds=0.01)


@pytest.fixture
def env(tmp_path, monkeypatch):
    monkeypatch.setattr(db, "DATA_DIR", tmp_path)
    monkeypatch.setattr(db, "DB_PATH", tmp_path / "scheduler.db")
    monkeypatch.setattr(db, "SEED_PATH", tmp_path / "no-seed.db")
    monkeypatch.setattr(main, "DEMO_USERS", {"demo"})
    monkeypatch.setattr(main, "rate_limiter", auth.LoginRateLimiter())
    monkeypatch.setattr(main, "_jobs", {})
    fake = FakeSolver()
    monkeypatch.setattr(main, "solve", fake)
    with TestClient(main.app) as client:
        db.create_user("alice", auth.hash_password("alice-pass-1"))
        db.create_user("bob", auth.hash_password("bob-pass-12"))
        db.create_user("demo", auth.hash_password("demo-pass-1"))
        db.create_user("root", auth.hash_password("root-pass-1"), role="admin")
        yield client, fake


def login(username, password) -> TestClient:
    c = TestClient(main.app)
    r = c.post("/api/auth/login", json={"username": username, "password": password})
    assert r.status_code == 200, r.text
    return c


def problem_json(**solver):
    data = copy.deepcopy(EXAMPLE)
    data["solver"].update(solver)
    return data


def wait_done(client, job_id):
    for _ in range(200):
        r = client.get(f"/api/jobs/{job_id}")
        if r.json()["state"] == "done":
            return r
        time.sleep(0.02)
    raise AssertionError("job did not finish")


# ---------- 強制改密碼 ----------

def test_default_admin_blocked_until_password_changed(env):
    admin = login("admin", "admin123")
    me = admin.get("/api/auth/me").json()
    assert me["mustChangePassword"] is True
    assert admin.get("/api/templates").status_code == 403
    assert admin.get("/api/admin/users").status_code == 403
    assert admin.post("/api/solve", json=problem_json()).status_code == 403

    r = admin.post("/api/auth/change-password",
                   json={"oldPassword": "admin123", "newPassword": "new-strong-pw"})
    assert r.status_code == 200
    assert admin.get("/api/templates").status_code == 200
    assert admin.get("/api/admin/users").status_code == 200


def test_wrong_old_password_is_not_401(env):
    # 401 會讓前端以為登入失效而跳回登入頁
    alice = login("alice", "alice-pass-1")
    r = alice.post("/api/auth/change-password",
                   json={"oldPassword": "wrong", "newPassword": "whatever-123"})
    assert r.status_code == 400


# ---------- 展示帳號 ----------

def test_demo_account_cannot_change_password(env):
    demo = login("demo", "demo-pass-1")
    assert demo.get("/api/auth/me").json()["isDemo"] is True
    r = demo.post("/api/auth/change-password",
                  json={"oldPassword": "demo-pass-1", "newPassword": "hijacked-123"})
    assert r.status_code == 403
    login("demo", "demo-pass-1")  # 原密碼仍可登入


# ---------- session 失效 ----------

def test_change_password_revokes_other_sessions(env):
    a1 = login("alice", "alice-pass-1")
    a2 = login("alice", "alice-pass-1")
    r = a1.post("/api/auth/change-password",
                json={"oldPassword": "alice-pass-1", "newPassword": "alice-pass-2"})
    assert r.status_code == 200
    assert a1.get("/api/auth/me").status_code == 200
    assert a2.get("/api/auth/me").status_code == 401


def test_admin_reset_revokes_target_sessions(env):
    alice = login("alice", "alice-pass-1")
    root = login("root", "root-pass-1")
    uid = db.get_user_by_username("alice")["id"]
    r = root.post(f"/api/admin/users/{uid}/reset-password", json={"password": "reset-pass-1"})
    assert r.status_code == 200
    assert alice.get("/api/auth/me").status_code == 401


# ---------- 求解 ----------

def test_solver_settings_are_clamped(env):
    _, fake = env
    alice = login("alice", "alice-pass-1")
    body = problem_json(timeLimitSeconds=999999, numWorkers=64,
                        diagnoseProbeSeconds=500, diagnoseBudgetSeconds=99999)
    job = alice.post("/api/solve", json=body).json()["jobId"]
    wait_done(alice, job)
    cfg = fake.problems[-1].solver
    assert cfg.time_limit_seconds == main.SOLVE_MAX_SECONDS
    assert cfg.num_workers <= main.SOLVE_MAX_WORKERS
    assert cfg.diagnose_probe_seconds == main.DIAGNOSE_MAX_PROBE_SECONDS
    assert cfg.diagnose_budget_seconds == main.DIAGNOSE_MAX_TOTAL_SECONDS


def test_one_running_job_per_user(env):
    _, fake = env
    fake.gate.clear()
    alice = login("alice", "alice-pass-1")
    bob = login("bob", "bob-pass-12")
    first = alice.post("/api/solve", json=problem_json()).json()["jobId"]
    assert alice.post("/api/solve", json=problem_json()).status_code == 429
    assert bob.post("/api/solve", json=problem_json()).status_code == 200  # 別人不受影響
    fake.gate.set()
    wait_done(alice, first)
    assert alice.post("/api/solve", json=problem_json()).status_code == 200


def test_job_result_only_visible_to_owner(env):
    alice = login("alice", "alice-pass-1")
    bob = login("bob", "bob-pass-12")
    root = login("root", "root-pass-1")
    job = alice.post("/api/solve", json=problem_json()).json()["jobId"]
    wait_done(alice, job)
    assert bob.get(f"/api/jobs/{job}").status_code == 404
    assert root.get(f"/api/jobs/{job}").status_code == 200

    # 從記憶體清掉後改走資料庫查詢，一樣要檢查歸屬
    main._jobs.clear()
    assert bob.get(f"/api/jobs/{job}").status_code == 404
    assert alice.get(f"/api/jobs/{job}").status_code == 200


def test_finished_jobs_are_pruned(env):
    alice = login("alice", "alice-pass-1")
    job = alice.post("/api/solve", json=problem_json()).json()["jobId"]
    wait_done(alice, job)
    main._jobs[job]["finished_at"] = time.time() - main.JOB_RETENTION_SECONDS - 1
    wait_done(alice, alice.post("/api/solve", json=problem_json()).json()["jobId"])
    assert job not in main._jobs


def test_interrupted_job_reports_restart(env):
    alice = login("alice", "alice-pass-1")
    uid = db.get_user_by_username("alice")["id"]
    sid = db.create_schedule(uid, "x", {"meta": {}})
    db.update_schedule(sid, result={"status": "feasible", "stale": True})
    db.record_job_start("deadbeef0001", uid, sid)
    db.mark_stale_jobs()  # 模擬伺服器重啟
    r = alice.get("/api/jobs/deadbeef0001").json()
    assert r["result"]["status"] == "error"
    assert "重新啟動" in r["result"]["error"]


def test_diagnose_respects_budget():
    p = Problem.model_validate(problem_json(diagnoseProbeSeconds=5, diagnoseBudgetSeconds=1))
    d = diagnose(p)
    assert d.conflict_ids == []
    assert any("時間上限" in s for s in d.suggestions)


# ---------- 備份與種子 ----------

def test_backup_temp_file_is_removed(env):
    root = login("root", "root-pass-1")
    tmpdir = Path(tempfile.gettempdir())
    before = set(tmpdir.glob("scheduler-backup-*.db"))
    r = root.get("/api/admin/backup")
    assert r.status_code == 200 and len(r.content) > 0
    assert set(tmpdir.glob("scheduler-backup-*.db")) == before


def test_seed_copied_on_first_start(tmp_path, monkeypatch):
    seed = tmp_path / "seed.db"
    monkeypatch.setattr(db, "DATA_DIR", tmp_path)
    monkeypatch.setattr(db, "DB_PATH", seed)
    db.init_db()
    db.create_user("seeded", auth.hash_password("x" * 8))
    monkeypatch.setattr(db, "DB_PATH", tmp_path / "scheduler.db")
    monkeypatch.setattr(db, "SEED_PATH", seed)
    db.init_db()
    assert db.get_user_by_username("seeded") is not None


def test_job_finishes_even_if_db_write_fails(env, monkeypatch):
    # 求解失敗後連寫入資料庫也失敗時，工作仍要結束，使用者才能再次排班
    def broken_solve(problem, progress_cb=None):
        raise RuntimeError("solver crashed")

    def broken_record(*args, **kwargs):
        raise RuntimeError("database is locked")

    monkeypatch.setattr(main, "solve", broken_solve)
    monkeypatch.setattr(db, "record_job_end", broken_record)
    alice = login("alice", "alice-pass-1")
    job = alice.post("/api/solve", json=problem_json()).json()["jobId"]
    assert wait_done(alice, job).json()["result"]["status"] == "error"
    assert alice.post("/api/solve", json=problem_json()).status_code == 200
