"""密碼雜湊（scrypt，標準庫）與登入限流。"""
from __future__ import annotations

import hashlib
import hmac
import secrets
import time


def hash_password(password: str) -> str:
    salt = secrets.token_bytes(16)
    digest = hashlib.scrypt(password.encode("utf-8"), salt=salt, n=2 ** 14, r=8, p=1)
    return salt.hex() + "$" + digest.hex()


def verify_password(password: str, stored: str) -> bool:
    try:
        salt_hex, digest_hex = stored.split("$", 1)
        digest = hashlib.scrypt(password.encode("utf-8"), salt=bytes.fromhex(salt_hex),
                                n=2 ** 14, r=8, p=1)
        return hmac.compare_digest(digest.hex(), digest_hex)
    except Exception:
        return False


def new_session_token() -> str:
    return secrets.token_urlsafe(32)


class LoginRateLimiter:
    """每個來源 IP 15 分鐘內最多 10 次失敗嘗試。"""

    def __init__(self, max_attempts: int = 10, window_seconds: int = 900):
        self.max_attempts = max_attempts
        self.window = window_seconds
        self._attempts: dict[str, list[float]] = {}

    def blocked(self, ip: str) -> bool:
        now = time.time()
        attempts = [t for t in self._attempts.get(ip, []) if now - t < self.window]
        self._attempts[ip] = attempts
        return len(attempts) >= self.max_attempts

    def record_failure(self, ip: str):
        self._attempts.setdefault(ip, []).append(time.time())

    def reset(self, ip: str):
        self._attempts.pop(ip, None)
