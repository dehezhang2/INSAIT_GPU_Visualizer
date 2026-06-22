"""Make-before-break job migration.

Move a job onto a target node without ever giving up the old allocation: submit
the new job (pinned to the node), and only `scancel` the original once the new
one is actually RUNNING. A single background daemon thread watches all active
migrations. If the new job fails or you abort, the original is left untouched.

The engine is decoupled from *how* the new job is created: the caller passes a
`submit_fn()` returning the new job id (clone of the old job, or a fresh catalog
job / holder-swap). State lives in memory and is exposed for the progress UI.
"""
from __future__ import annotations

import threading
import time

import slurm

# terminal Slurm states that mean the new job will never run
_DEAD = {"FAILED", "CANCELLED", "TIMEOUT", "NODE_FAIL", "BOOT_FAIL",
         "OUT_OF_MEMORY", "DEADLINE", "PREEMPTED", "SPECIAL_EXIT"}
_RUN_OK = {"RUNNING", "COMPLETING", "COMPLETED"}

_migrations: dict[int, dict] = {}
_seq = 0
_lock = threading.Lock()
_worker: threading.Thread | None = None


def _now() -> float:
    return time.time()


def _log(m: dict, msg: str):
    m["log"].append({"t": round(_now()), "msg": msg})
    m["updated_at"] = _now()


def list_migrations() -> list[dict]:
    with _lock:
        return sorted(_migrations.values(), key=lambda x: -x["id"])


def get(mid: int) -> dict | None:
    with _lock:
        return _migrations.get(mid)


def create(src_job_id, target_node, submit_fn, label: str = "",
           timeout_s: float = 1800) -> dict:
    """Start a migration. submit_fn() must submit the new job and return its id.
    The old job is NOT touched until the new one is RUNNING. If the new job has
    not started within timeout_s, give up: cancel the still-pending clone and
    keep the original (so a late start can't leave both running)."""
    global _seq
    with _lock:
        _seq += 1
        m = {
            "id": _seq,
            "src_job_id": str(src_job_id),
            "target_node": target_node,
            "label": label,
            "new_job_id": None,
            "state": "submitting",   # submitting|waiting|swapping|done|failed|aborted
            "log": [],
            "created_at": _now(),
            "updated_at": _now(),
            "timeout_s": timeout_s,
        }
        _migrations[m["id"]] = m
    _log(m, f"submitting new job → {target_node}")
    try:
        new_id = submit_fn()
        m["new_job_id"] = str(new_id)
        m["state"] = "waiting"
        _log(m, f"submitted new job {new_id}; waiting for it to RUN before "
                f"cancelling {src_job_id}")
    except Exception as e:  # noqa: BLE001
        m["state"] = "failed"
        _log(m, f"submit failed: {e}; original job left intact")
    _ensure_worker()
    return m


def abort(mid: int) -> bool:
    with _lock:
        m = _migrations.get(mid)
    if not m:
        return False
    if m["state"] in ("done", "failed", "aborted"):
        return False
    if m.get("new_job_id"):
        try:
            slurm.cancel(m["new_job_id"])
            _log(m, f"aborted: cancelled new job {m['new_job_id']}; "
                    f"original {m['src_job_id']} kept")
        except Exception as e:  # noqa: BLE001
            _log(m, f"abort: could not cancel new job: {e}")
    m["state"] = "aborted"
    return True


def clear_finished():
    with _lock:
        for mid in [k for k, v in _migrations.items()
                    if v["state"] in ("done", "failed", "aborted")]:
            del _migrations[mid]


def _step(m: dict):
    if m["state"] != "waiting" or not m.get("new_job_id"):
        return
    # give up if the clone never starts — and cancel it, so a late start can't
    # leave the original AND the clone both running
    timeout = m.get("timeout_s") or 0
    if timeout and (_now() - m["created_at"]) > timeout:
        try:
            slurm.cancel(m["new_job_id"])
        except Exception:  # noqa: BLE001
            pass
        m["state"] = "failed"
        mins = round(timeout / 60)
        _log(m, f"timed out (clone未在 {mins} 分钟内启动);已取消克隆,保留原任务")
        return
    st = slurm.job_state(m["new_job_id"])
    if st in _RUN_OK:
        m["state"] = "swapping"
        _log(m, f"new job {m['new_job_id']} is {st} → cancelling original "
                f"{m['src_job_id']}")
        try:
            slurm.cancel(m["src_job_id"])
            m["state"] = "done"
            _log(m, "migration complete (make-before-break, no gap)")
        except Exception as e:  # noqa: BLE001
            m["state"] = "failed"
            _log(m, f"new job is up but cancelling original failed: {e} "
                    f"(both may be running — check manually)")
    elif st in _DEAD:
        m["state"] = "failed"
        _log(m, f"new job ended as {st}; original kept running")
    elif st is None:
        # transient lookup miss; tolerate a few before giving up
        m["_misses"] = m.get("_misses", 0) + 1
        if m["_misses"] >= 4:
            m["state"] = "failed"
            _log(m, "lost track of new job; original kept running")
    else:
        m["_misses"] = 0  # still PENDING/CONFIGURING


def _loop():
    while True:
        time.sleep(5)
        for m in list_migrations():
            if m["state"] == "waiting":
                try:
                    _step(m)
                except Exception as e:  # noqa: BLE001
                    _log(m, f"watcher error: {e}")


def _ensure_worker():
    global _worker
    if _worker is None or not _worker.is_alive():
        _worker = threading.Thread(target=_loop, daemon=True, name="migrate-worker")
        _worker.start()
