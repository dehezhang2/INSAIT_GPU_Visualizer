#!/usr/bin/env python3
"""auth.py — username/password login + in-memory sessions (pure stdlib).

Credentials live in ~/.gpuviz/auth.json (PBKDF2-SHA256, file mode 0600),
created/updated via `python3 server.py --set-password`. Sessions are random
tokens held in server memory — like migrations, they don't survive a restart.

Why this exists: binding to 127.0.0.1 does NOT protect a shared login node —
every user on the same host can reach localhost, and the API runs Slurm
commands as whoever started the server.
"""
from __future__ import annotations

import getpass
import hashlib
import hmac
import json
import os
import secrets
import threading
import time

AUTH_FILE = os.path.expanduser("~/.gpuviz/auth.json")
COOKIE = "gpuviz_session"
ITERATIONS = 600_000
SESSION_TTL = 7 * 24 * 3600  # sliding: refreshed on every authed request

_enabled = True
_lock = threading.Lock()
_sessions: dict = {}  # token -> {"user": str, "expires": float}


def disable():
    global _enabled
    _enabled = False


def enabled() -> bool:
    return _enabled


def configured() -> bool:
    return os.path.isfile(AUTH_FILE)


def _load():
    try:
        with open(AUTH_FILE) as f:
            return json.load(f)
    except (OSError, json.JSONDecodeError):
        return None


def set_password(username=None, password=None):
    """Create/update credentials; prompts interactively unless args given."""
    cur = _load() or {}
    if username is None:
        default = cur.get("username") or getpass.getuser()
        username = input(f"username [{default}]: ").strip() or default
    while password is None:
        pw = getpass.getpass("password: ")
        if len(pw) < 4:
            print("  password too short (min 4 chars)")
            continue
        if pw != getpass.getpass("repeat  : "):
            print("  passwords do not match, try again")
            continue
        password = pw
    salt = secrets.token_bytes(16)
    dk = hashlib.pbkdf2_hmac("sha256", password.encode(), salt, ITERATIONS)
    os.makedirs(os.path.dirname(AUTH_FILE), exist_ok=True)
    tmp = AUTH_FILE + ".tmp"
    with open(tmp, "w") as f:
        json.dump({"username": username, "salt": salt.hex(),
                   "hash": dk.hex(), "iterations": ITERATIONS}, f, indent=2)
    os.chmod(tmp, 0o600)
    os.replace(tmp, AUTH_FILE)
    print(f"credentials for '{username}' written to {AUTH_FILE}")


def verify(username: str, password: str) -> bool:
    rec = _load()
    if not rec:
        return False
    dk = hashlib.pbkdf2_hmac("sha256", password.encode(),
                             bytes.fromhex(rec["salt"]),
                             int(rec.get("iterations") or ITERATIONS))
    ok = (hmac.compare_digest(username.encode(), str(rec["username"]).encode())
          & hmac.compare_digest(dk, bytes.fromhex(rec["hash"])))
    if not ok:
        time.sleep(0.8)  # slow down brute force
    return bool(ok)


# -- sessions ---------------------------------------------------------------

def new_session(user: str) -> str:
    tok = secrets.token_urlsafe(32)
    now = time.time()
    with _lock:
        for t in [t for t, s in _sessions.items() if s["expires"] < now]:
            del _sessions[t]
        _sessions[tok] = {"user": user, "expires": now + SESSION_TTL}
    return tok


def session_user(token):
    """Return the logged-in username for this token, or None."""
    if not token:
        return None
    now = time.time()
    with _lock:
        s = _sessions.get(token)
        if not s:
            return None
        if s["expires"] < now:
            del _sessions[token]
            return None
        s["expires"] = now + SESSION_TTL
        return s["user"]


def drop_session(token):
    if token:
        with _lock:
            _sessions.pop(token, None)


def cookie(token: str, expire=False) -> str:
    """Set-Cookie value. No `Secure` flag: served over http via SSH tunnel."""
    if expire:
        return f"{COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0"
    return f"{COOKIE}={token}; Path=/; HttpOnly; SameSite=Lax; Max-Age={SESSION_TTL}"


def token_from(cookie_header) -> str:
    for part in (cookie_header or "").split(";"):
        k, _, v = part.strip().partition("=")
        if k == COOKIE:
            return v
    return ""
