"""gpuviz_monitor — report live progress to the GPU Visualizer from any repo.

Copy this single file into your project (or add this repo to PYTHONPATH), then:

    from gpuviz_monitor import Monitor

    with Monitor("ckpt-migrate", label="move step-20000 → sof1", kind="migration",
                 repo="InvariantBench") as m:
        for i in range(total):
            ... do work ...
            m.step(i + 1, total, message=f"copying shard {i}")
    # on success the monitor is marked done; on exception it's marked failed.

Or one-off:   report("eval-vsi", percent=42, message="batch 210/500")
Or CLI:       python gpuviz_monitor.py --key eval-vsi --percent 42 --message "..."

Transport: tries HTTP POST to $GPUVIZ_URL (default http://127.0.0.1:8770); if the
server isn't reachable (e.g. you're inside a compute-node job), it falls back to
dropping a JSON file in ~/.gpuviz/monitors/ which the server also ingests.
"""
from __future__ import annotations

import json
import os
import time
import urllib.request

URL = os.environ.get("GPUVIZ_URL", "http://127.0.0.1:8770").rstrip("/")
DIR = os.path.expanduser("~/.gpuviz/monitors")


def report(key, percent=None, message="", status="running", label=None,
           kind="custom", repo=None, **extra) -> None:
    """Send/refresh one progress update. Never raises (best-effort)."""
    rec = {"key": key, "status": status, "message": message, "kind": kind}
    if percent is not None:
        rec["percent"] = round(float(percent), 1)
    if label:
        rec["label"] = label
    if repo or os.environ.get("GPUVIZ_REPO"):
        rec["repo"] = repo or os.environ.get("GPUVIZ_REPO")
    if os.environ.get("SLURM_JOB_ID"):
        rec.setdefault("job_id", os.environ["SLURM_JOB_ID"])
    if os.environ.get("SLURMD_NODENAME"):
        rec.setdefault("node", os.environ["SLURMD_NODENAME"])
    rec.update(extra)
    body = json.dumps(rec).encode()
    # 1) try HTTP
    try:
        req = urllib.request.Request(URL + "/api/monitors", body,
                                     {"Content-Type": "application/json"})
        urllib.request.urlopen(req, timeout=3).read()
        return
    except Exception:
        pass
    # 2) fall back to a file drop on shared /home
    try:
        os.makedirs(DIR, exist_ok=True)
        rec["updated"] = time.time()
        tmp = os.path.join(DIR, f".{key}.tmp")
        with open(tmp, "w") as f:
            json.dump(rec, f)
        os.replace(tmp, os.path.join(DIR, f"{key}.json"))
    except OSError:
        pass


class Monitor:
    def __init__(self, key, label=None, kind="custom", repo=None, total=None):
        self.key, self.label, self.kind, self.repo, self.total = key, label, kind, repo, total
        report(key, percent=0, message="started", label=label, kind=kind, repo=repo)

    def update(self, percent=None, message="", **extra):
        report(self.key, percent=percent, message=message, label=self.label,
               kind=self.kind, repo=self.repo, **extra)

    def step(self, i, total=None, message=""):
        total = total or self.total
        pct = (100.0 * i / total) if total else None
        report(self.key, percent=pct, message=message or f"{i}/{total}",
               label=self.label, kind=self.kind, repo=self.repo, step=i, total=total)

    def done(self, message="done"):
        report(self.key, percent=100, message=message, status="done",
               label=self.label, kind=self.kind, repo=self.repo)

    def fail(self, message="failed"):
        report(self.key, message=message, status="failed",
               label=self.label, kind=self.kind, repo=self.repo)

    def __enter__(self):
        return self

    def __exit__(self, exc_type, exc, tb):
        self.fail(repr(exc)) if exc_type else self.done()
        return False


if __name__ == "__main__":
    import argparse
    ap = argparse.ArgumentParser()
    ap.add_argument("--key", required=True)
    ap.add_argument("--percent", type=float)
    ap.add_argument("--message", default="")
    ap.add_argument("--status", default="running")
    ap.add_argument("--label")
    ap.add_argument("--kind", default="custom")
    ap.add_argument("--repo")
    a = ap.parse_args()
    report(a.key, percent=a.percent, message=a.message, status=a.status,
           label=a.label, kind=a.kind, repo=a.repo)
    print(f"reported {a.key}: {a.percent}% {a.status}")
