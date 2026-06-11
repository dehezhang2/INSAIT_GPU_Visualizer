"""Data-dependency checks for a job's `needs` declarations.

For each declared path we report whether it's present, roughly how big it is,
and whether it lives on another site (which would require staging before the job
can run there — the cross-site transfer itself is a separate, opt-in step).
"""
from __future__ import annotations

import os
import subprocess

import slurm


def _dir_size_gb(path: str, timeout: int = 4) -> float | None:
    """Best-effort size via `du`; bounded so huge trees don't stall the UI."""
    try:
        out = subprocess.run(["du", "-sb", path], capture_output=True, text=True,
                             timeout=timeout).stdout
        return int(out.split()[0]) / 1e9
    except (subprocess.TimeoutExpired, ValueError, IndexError, FileNotFoundError):
        return None


def _node_local(path: str) -> bool:
    """/scratch is node-local ext4; it can't be staged from a login node."""
    return path.startswith("/scratch/") or path == "/scratch"


def check_one(need: dict) -> dict:
    path = need["path"]
    exists = os.path.exists(path)
    site = need.get("site")
    here = slurm.current_site()
    remote = bool(site and site != here)

    status = "ok"
    detail = ""
    size_gb = None
    src_host = None
    stageable = False
    if remote and not exists:
        status = "remote"
        if _node_local(path):
            detail = f"在 {site};{path} 是节点本地 /scratch,登录节点搬不过去 → 需在作业内 stage"
        else:
            src_host = slurm.login_hosts().get(site)
            stageable = bool(src_host)
            detail = (f"在 {site},当前 {here} 不可见 → 可 rsync 暂存"
                      if stageable else f"在 {site},但找不到该站登录节点")
    elif not exists:
        status = "missing"
        detail = "路径不存在"
    else:
        if need.get("min_gb"):
            size_gb = _dir_size_gb(path)
            if size_gb is not None and size_gb < float(need["min_gb"]):
                status = "small"
                detail = f"{size_gb:.1f}GB < 要求 {need['min_gb']}GB"
    return {
        "path": path,
        "raw_path": need.get("raw_path", path),
        "site": site,
        "min_gb": need.get("min_gb"),
        "exists": exists,
        "size_gb": size_gb,
        "status": status,   # ok | missing | small | remote
        "detail": detail,
        "src_host": src_host,      # login node to rsync from (if stageable)
        "stageable": stageable,
    }


def check(needs: list[dict]) -> dict:
    items = [check_one(n) for n in (needs or [])]
    if not items:
        overall = "none"
    elif any(i["status"] in ("missing",) for i in items):
        overall = "missing"
    elif any(i["status"] == "remote" for i in items):
        overall = "remote"
    elif any(i["status"] == "small" for i in items):
        overall = "small"
    else:
        overall = "ok"
    return {"overall": overall, "items": items}
