"""Cross-site data staging via `rsync over ssh` between login nodes.

Each site has its own Ceph for /group, so data declared with `site=X` must be
copied from site X's login node to ours before a job here can use it. We run
rsync with --info=progress2, parse the running percentage/rate, and expose it for
a progress bar. A background reader thread per transfer keeps state live.

Only /group-style (site-shared) paths are meaningfully stageable this way;
node-local /scratch can't be reached from a login node (flagged elsewhere).
"""
from __future__ import annotations

import os
import re
import subprocess
import threading

_transfers: dict[int, dict] = {}
_seq = 0
_lock = threading.Lock()

# rsync --info=progress2 line, e.g. "  1,234,567  45%   12.34MB/s    0:00:12"
_PROG = re.compile(r"([\d,]+)\s+(\d+)%\s+([\d.]+[KMGT]?B/s)")


def list_transfers() -> list[dict]:
    with _lock:
        return sorted((_public(t) for t in _transfers.values()), key=lambda x: -x["id"])


def _public(t: dict) -> dict:
    return {k: v for k, v in t.items() if k != "proc"}


def create(src_host: str, src_path: str, dst_path: str | None = None) -> dict:
    """Start `rsync -a src_host:src_path/ dst_path/`. dst defaults to src_path
    (same path string, resolving to our site's store)."""
    global _seq
    dst = dst_path or src_path
    with _lock:
        _seq += 1
        t = {
            "id": _seq, "src": f"{src_host}:{src_path}", "dst": dst,
            "state": "running", "percent": 0, "rate": "", "line": "",
            "log": [], "proc": None,
        }
        _transfers[t["id"]] = t
    os.makedirs(dst, exist_ok=True)
    # BatchMode=yes → fail fast on a missing key instead of hanging on a prompt
    cmd = ["rsync", "-a", "--info=progress2",
           "-e", "ssh -o BatchMode=yes -o StrictHostKeyChecking=accept-new",
           f"{src_host}:{src_path.rstrip('/')}/", dst.rstrip("/") + "/"]
    t["log"].append("$ " + " ".join(cmd))
    try:
        t["proc"] = subprocess.Popen(cmd, stdout=subprocess.PIPE,
                                     stderr=subprocess.STDOUT, bufsize=0)
    except FileNotFoundError as e:
        t["state"] = "failed"
        t["log"].append(f"could not start rsync: {e}")
        return _public(t)
    threading.Thread(target=_reader, args=(t,), daemon=True).start()
    return _public(t)


def _reader(t: dict):
    proc = t["proc"]
    buf = b""
    tail = []
    while True:
        chunk = proc.stdout.read(256)
        if not chunk:
            break
        buf += chunk
        # rsync rewrites the progress line with \r; split on both
        parts = re.split(rb"[\r\n]", buf)
        buf = parts.pop()
        for raw in parts:
            line = raw.decode("utf-8", "replace").strip()
            if not line:
                continue
            m = _PROG.search(line)
            if m:
                t["percent"] = int(m.group(2))
                t["rate"] = m.group(3)
                t["line"] = line
            else:
                tail.append(line)
                tail[:] = tail[-8:]
                t["line"] = line
    code = proc.wait()
    if t["state"] == "aborted":
        pass
    elif code == 0:
        t["state"] = "done"
        t["percent"] = 100
    else:
        t["state"] = "failed"
    if tail:
        t["log"].extend(tail[-8:])
    t["log"].append(f"rsync exit {code}")


def abort(tid: int) -> bool:
    with _lock:
        t = _transfers.get(tid)
    if not t or t["state"] != "running":
        return False
    t["state"] = "aborted"
    if t.get("proc"):
        try:
            t["proc"].terminate()
        except ProcessLookupError:
            pass
    t["log"].append("aborted by user")
    return True


def clear_finished():
    with _lock:
        for tid in [k for k, v in _transfers.items()
                    if v["state"] in ("done", "failed", "aborted")]:
            del _transfers[tid]
