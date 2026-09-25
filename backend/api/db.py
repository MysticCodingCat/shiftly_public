"""SQLite 資料層：使用者、session、班表文件、求解記錄。"""
from __future__ import annotations

import json
import sqlite3
import time
from pathlib import Path
from typing import Any, Optional

ROOT = Path(__file__).resolve().parent.parent.parent
DATA_DIR = ROOT / "data"
DB_PATH = DATA_DIR / "scheduler.db"
SEED_PATH = DATA_DIR / "seed.db"   # 版控中的初始資料；scheduler.db 為執行期檔案，不進版控

SCHEMA_SQL = """
CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    display_name TEXT DEFAULT '',
    role TEXT NOT NULL DEFAULT 'unit',          -- admin | unit
    active INTEGER NOT NULL DEFAULT 1,
    must_change_password INTEGER NOT NULL DEFAULT 0,
    created_at REAL NOT NULL
);
CREATE TABLE IF NOT EXISTS sessions (
    token TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id),
    created_at REAL NOT NULL,
    expires_at REAL NOT NULL
);
CREATE TABLE IF NOT EXISTS schedules (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    owner_id INTEGER NOT NULL REFERENCES users(id),
    name TEXT NOT NULL DEFAULT '',
    schema_json TEXT NOT NULL,
    result_json TEXT,
    created_at REAL NOT NULL,
    updated_at REAL NOT NULL
);
CREATE TABLE IF NOT EXISTS jobs (
    id TEXT PRIMARY KEY,
    user_id INTEGER,
    schedule_id INTEGER,
    status TEXT NOT NULL,                        -- running | done | error | interrupted
    result_status TEXT,                          -- optimal | feasible | ...
    objective REAL,
    seconds REAL,
    created_at REAL NOT NULL,
    finished_at REAL
);
"""


def get_conn() -> sqlite3.Connection:
    DATA_DIR.mkdir(exist_ok=True)
    conn = sqlite3.connect(DB_PATH, timeout=15)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA foreign_keys=ON")
    return conn


def init_db():
    # 首次啟動時以種子檔建立資料庫（含示範帳號與班表）；已存在則不覆蓋
    if not DB_PATH.exists() and SEED_PATH.exists():
        DATA_DIR.mkdir(exist_ok=True)
        # 用 SQLite 備份 API 而非直接複製檔案，種子檔若有未合併的 WAL 內容也不會遺漏
        src, dst = sqlite3.connect(SEED_PATH), sqlite3.connect(DB_PATH)
        try:
            src.backup(dst)
        finally:
            src.close()
            dst.close()
    with get_conn() as conn:
        conn.executescript(SCHEMA_SQL)


# ---------- users ----------

def get_user_by_username(username: str) -> Optional[sqlite3.Row]:
    with get_conn() as conn:
        return conn.execute("SELECT * FROM users WHERE username = ?", (username,)).fetchone()


def get_user(user_id: int) -> Optional[sqlite3.Row]:
    with get_conn() as conn:
        return conn.execute("SELECT * FROM users WHERE id = ?", (user_id,)).fetchone()


def create_user(username: str, password_hash: str, display_name: str = "",
                role: str = "unit", must_change: bool = False) -> int:
    with get_conn() as conn:
        cur = conn.execute(
            "INSERT INTO users (username, password_hash, display_name, role, active, must_change_password, created_at) "
            "VALUES (?, ?, ?, ?, 1, ?, ?)",
            (username, password_hash, display_name, role, int(must_change), time.time()))
        return cur.lastrowid


def list_users() -> list[sqlite3.Row]:
    with get_conn() as conn:
        return conn.execute("SELECT * FROM users ORDER BY id").fetchall()


def update_user_password(user_id: int, password_hash: str, must_change: bool = False):
    with get_conn() as conn:
        conn.execute("UPDATE users SET password_hash = ?, must_change_password = ? WHERE id = ?",
                     (password_hash, int(must_change), user_id))


def set_user_active(user_id: int, active: bool):
    with get_conn() as conn:
        conn.execute("UPDATE users SET active = ? WHERE id = ?", (int(active), user_id))
        if not active:
            conn.execute("DELETE FROM sessions WHERE user_id = ?", (user_id,))


def user_count() -> int:
    with get_conn() as conn:
        return conn.execute("SELECT COUNT(*) AS n FROM users").fetchone()["n"]


# ---------- sessions ----------

SESSION_TTL = 30 * 86400


def create_session(token: str, user_id: int):
    now = time.time()
    with get_conn() as conn:
        conn.execute("INSERT INTO sessions (token, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)",
                     (token, user_id, now, now + SESSION_TTL))
        conn.execute("DELETE FROM sessions WHERE expires_at < ?", (now,))


def get_session_user(token: str) -> Optional[sqlite3.Row]:
    with get_conn() as conn:
        return conn.execute(
            "SELECT u.* FROM sessions s JOIN users u ON u.id = s.user_id "
            "WHERE s.token = ? AND s.expires_at > ? AND u.active = 1",
            (token, time.time())).fetchone()


def delete_session(token: str):
    with get_conn() as conn:
        conn.execute("DELETE FROM sessions WHERE token = ?", (token,))


def delete_user_sessions(user_id: int, keep_token: Optional[str] = None):
    """讓某使用者的所有登入失效（改密碼、重設密碼時用），可保留目前這個 session。"""
    with get_conn() as conn:
        conn.execute("DELETE FROM sessions WHERE user_id = ? AND token IS NOT ?",
                     (user_id, keep_token))


# ---------- schedules ----------

def create_schedule(owner_id: int, name: str, schema: dict) -> int:
    now = time.time()
    with get_conn() as conn:
        cur = conn.execute(
            "INSERT INTO schedules (owner_id, name, schema_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
            (owner_id, name, json.dumps(schema, ensure_ascii=False), now, now))
        return cur.lastrowid


def list_schedules(owner_id: Optional[int] = None) -> list[dict]:
    sql = ("SELECT s.id, s.owner_id, s.name, s.created_at, s.updated_at, "
           "s.result_json IS NOT NULL AS has_result, u.username AS owner_name, u.display_name AS owner_display "
           "FROM schedules s JOIN users u ON u.id = s.owner_id ")
    args: tuple = ()
    if owner_id is not None:
        sql += "WHERE s.owner_id = ? "
        args = (owner_id,)
    sql += "ORDER BY s.updated_at DESC"
    with get_conn() as conn:
        return [dict(r) for r in conn.execute(sql, args).fetchall()]


def get_schedule(schedule_id: int) -> Optional[sqlite3.Row]:
    with get_conn() as conn:
        return conn.execute("SELECT * FROM schedules WHERE id = ?", (schedule_id,)).fetchone()


def update_schedule(schedule_id: int, name: Optional[str] = None,
                    schema: Optional[dict] = None, result: Optional[dict] = None):
    sets, args = ["updated_at = ?"], [time.time()]
    if name is not None:
        sets.append("name = ?")
        args.append(name)
    if schema is not None:
        sets.append("schema_json = ?")
        args.append(json.dumps(schema, ensure_ascii=False))
    if result is not None:
        sets.append("result_json = ?")
        args.append(json.dumps(result, ensure_ascii=False))
    args.append(schedule_id)
    with get_conn() as conn:
        conn.execute(f"UPDATE schedules SET {', '.join(sets)} WHERE id = ?", args)


def delete_schedule(schedule_id: int):
    with get_conn() as conn:
        conn.execute("DELETE FROM schedules WHERE id = ?", (schedule_id,))


def schedule_count() -> int:
    with get_conn() as conn:
        return conn.execute("SELECT COUNT(*) AS n FROM schedules").fetchone()["n"]


# ---------- jobs ----------

def record_job_start(job_id: str, user_id: Optional[int], schedule_id: Optional[int]):
    with get_conn() as conn:
        conn.execute("INSERT INTO jobs (id, user_id, schedule_id, status, created_at) VALUES (?, ?, ?, 'running', ?)",
                     (job_id, user_id, schedule_id, time.time()))


def record_job_end(job_id: str, status: str, result_status: Optional[str],
                   objective: Optional[float], seconds: Optional[float]):
    with get_conn() as conn:
        conn.execute(
            "UPDATE jobs SET status = ?, result_status = ?, objective = ?, seconds = ?, finished_at = ? WHERE id = ?",
            (status, result_status, objective, seconds, time.time(), job_id))


def get_job(job_id: str) -> Optional[sqlite3.Row]:
    with get_conn() as conn:
        return conn.execute("SELECT * FROM jobs WHERE id = ?", (job_id,)).fetchone()


def mark_stale_jobs():
    """啟動時把上次關機遺留的 running 工作標記為中斷。"""
    with get_conn() as conn:
        conn.execute("UPDATE jobs SET status = 'interrupted', finished_at = ? "
                     "WHERE status = 'running'", (time.time(),))


def list_jobs(limit: int = 100) -> list[dict]:
    with get_conn() as conn:
        rows = conn.execute(
            "SELECT j.*, u.username, s.name AS schedule_name FROM jobs j "
            "LEFT JOIN users u ON u.id = j.user_id "
            "LEFT JOIN schedules s ON s.id = j.schedule_id "
            "ORDER BY j.created_at DESC LIMIT ?", (limit,)).fetchall()
        return [dict(r) for r in rows]


def job_count() -> int:
    with get_conn() as conn:
        return conn.execute("SELECT COUNT(*) AS n FROM jobs").fetchone()["n"]
