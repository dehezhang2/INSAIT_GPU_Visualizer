"""groups.py — GUI-managed project folders for jobs.

The user creates folders in the WebUI and drags job cards into them; every
job then carries a project label independent of any gpuviz.toml. Persisted
in ~/.gpuviz/groups.json:

  folders : ["conesplat", "invariantbench", ...]   (display order)
  by_id   : {"1234": {"g": "conesplat", "t": epoch}}  explicit assignment;
            g="" is a tombstone = "user ungrouped this job, ignore fallbacks"
  by_name : {"train_lego": "conesplat"}  sticky: a resubmitted job with the
            same name lands back in its folder even though the id changed

Resolution order for a job's folder: by_id → by_name → origin repo project.
"""
from __future__ import annotations

import json
import os
import threading
import time

STORE = os.path.expanduser("~/.gpuviz/groups.json")
_ID_TTL = 30 * 86400  # by_id entries die with their (long-gone) jobs

_lock = threading.Lock()


def _load() -> dict:
    try:
        with open(STORE) as f:
            d = json.load(f)
    except (OSError, json.JSONDecodeError):
        d = {}
    d.setdefault("folders", [])
    d.setdefault("by_id", {})
    d.setdefault("by_name", {})
    return d


def _save(d: dict):
    now = time.time()
    d["by_id"] = {k: v for k, v in d["by_id"].items()
                  if now - v.get("t", now) < _ID_TTL}
    os.makedirs(os.path.dirname(STORE), exist_ok=True)
    tmp = STORE + ".tmp"
    with open(tmp, "w") as f:
        json.dump(d, f, indent=2)
    os.replace(tmp, STORE)


def snapshot() -> dict:
    with _lock:
        d = _load()
    return {"folders": d["folders"],
            "by_id": {k: v.get("g", "") for k, v in d["by_id"].items()},
            "by_name": d["by_name"]}


def resolve(job_id, name, snap) -> str | None:
    """Folder for one job, given a snapshot(). None = ungrouped."""
    jid = str(job_id).split("_")[0]
    if jid in snap["by_id"]:
        return snap["by_id"][jid] or None  # "" tombstone wins over the name rule
    if name and name in snap["by_name"]:
        return snap["by_name"][name]
    return None


def create(name: str) -> str:
    name = (name or "").strip()
    if not name:
        raise ValueError("folder name required")
    with _lock:
        d = _load()
        if name not in d["folders"]:
            d["folders"].append(name)
            _save(d)
    return name


def rename(old: str, new: str) -> bool:
    new = (new or "").strip()
    if not new:
        raise ValueError("new name required")
    with _lock:
        d = _load()
        if old not in d["folders"]:
            return False
        d["folders"] = [new if f == old else f for f in d["folders"]]
        for v in d["by_id"].values():
            if v.get("g") == old:
                v["g"] = new
        d["by_name"] = {k: (new if v == old else v) for k, v in d["by_name"].items()}
        _save(d)
    return True


def delete(name: str) -> bool:
    with _lock:
        d = _load()
        if name not in d["folders"]:
            return False
        d["folders"].remove(name)
        d["by_id"] = {k: v for k, v in d["by_id"].items() if v.get("g") != name}
        d["by_name"] = {k: v for k, v in d["by_name"].items() if v != name}
        _save(d)
    return True


def assign(job_id, name, folder, sticky=True):
    """Put a job in a folder (auto-creating it); folder=None/'' ungroups.

    sticky also records name→folder so future same-named jobs follow.
    """
    jid = str(job_id).split("_")[0]
    folder = (folder or "").strip()
    with _lock:
        d = _load()
        if folder and folder not in d["folders"]:
            d["folders"].append(folder)
        d["by_id"][jid] = {"g": folder, "t": time.time()}
        if sticky and name:
            if folder:
                d["by_name"][name] = folder
            else:
                d["by_name"].pop(name, None)
        _save(d)
