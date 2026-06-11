"""Read a job's stdout/stderr for the drill-in log viewer.

Slurm resolves %j/%x in the output paths, so we ask `scontrol show job` for the
final StdOut/StdErr and tail the files safely (bounded reads, no surprises on
multi-GB logs).
"""
from __future__ import annotations

import re
import subprocess

MAX_TAIL = 256 * 1024  # bytes shown by default


def resolve_paths(job_id: str) -> dict:
    """Return {'out': path|None, 'err': path|None, 'workdir': path|None}."""
    try:
        out = subprocess.run(["scontrol", "show", "job", str(job_id)],
                             capture_output=True, text=True, timeout=15).stdout
    except (subprocess.TimeoutExpired, FileNotFoundError):
        return {"out": None, "err": None, "workdir": None}
    fields = dict(re.findall(r"(StdOut|StdErr|WorkDir)=(\S+)", out))
    return {"out": fields.get("StdOut"), "err": fields.get("StdErr"),
            "workdir": fields.get("WorkDir")}


def read_tail(path: str | None, max_bytes: int = MAX_TAIL) -> dict:
    """Return {'path','exists','size','truncated','text'} for a log file."""
    if not path:
        return {"path": path, "exists": False, "size": 0, "truncated": False, "text": ""}
    try:
        with open(path, "rb") as f:
            f.seek(0, 2)
            size = f.tell()
            start = max(0, size - max_bytes)
            f.seek(start)
            data = f.read()
        return {
            "path": path,
            "exists": True,
            "size": size,
            "truncated": start > 0,
            "text": data.decode("utf-8", "replace"),
        }
    except FileNotFoundError:
        return {"path": path, "exists": False, "size": 0, "truncated": False, "text": ""}
    except OSError as e:
        return {"path": path, "exists": False, "size": 0, "truncated": False,
                "text": f"<cannot read: {e}>"}
