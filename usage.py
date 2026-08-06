"""usage.py — per-project GPU accounting, read out of sacct.

Every job the user ran in a window is mapped to its project folder (the same
resolution the Jobs tab uses: explicit assignment → sticky job name) and
aggregated into GPU-hours. Time is clamped to the window so a job that started
before it doesn't inflate the total, and long jobs are spread across the days
they actually occupied rather than dumped on their start date.
"""
from __future__ import annotations

import time

import groups
import slurm

_FIELDS = ["JobID", "JobName", "State", "Elapsed", "Start", "End",
           "Partition", "AllocTRES", "NodeList"]
_DAY = 86400


def _rows(days: int, ttl: float = 120.0) -> list[dict]:
    def fn():
        try:
            out = slurm._run(["sacct", "-u", slurm.USER, "-X", "-n", "-P",
                              "-S", f"now-{days}days",
                              "-o", ",".join(_FIELDS)], timeout=45)
        except slurm.SlurmError:
            return []
        rows = []
        for line in out.splitlines():
            f = line.split("|")
            if len(f) < len(_FIELDS):
                continue
            jid, name, state, elapsed, start, end, part, tres, nodelist = f[:len(_FIELDS)]
            gpus, gtype = slurm._parse_tres_gpu(tres)
            cpus = 0
            for chunk in (tres or "").split(","):
                k, _, v = chunk.partition("=")
                if k == "cpu" and v.isdigit():
                    cpus = int(v)
            rows.append({
                "id": jid,
                "name": name,
                "state": (state or "").split()[0],
                "elapsed_s": slurm._sacct_elapsed(elapsed) or 0,
                "start": slurm._sacct_time(start),
                "end": slurm._sacct_time(end),
                "gpus": gpus,
                "gpu_type": gtype or "gpu",
                "cpus": cpus,
                "partition": part,
                "nodes": nodelist,
            })
        return rows

    return slurm._cached(f"usage:{days}", ttl, fn)


def _span(r: dict, since: float, now: float) -> tuple[float, float]:
    """The job's [start,end) clamped to the window; running jobs end 'now'."""
    st = r["start"]
    if st is None:
        st = (r["end"] - r["elapsed_s"]) if r["end"] else None
    if st is None:
        return 0.0, 0.0
    en = r["end"] or now
    return max(st, since), min(en, now)


def summary(days: int = 30) -> dict:
    now = time.time()
    since = now - days * _DAY
    snap = groups.snapshot()
    day0 = int(since // _DAY)
    ndays = int(now // _DAY) - day0 + 1

    folders: dict[str, dict] = {}
    total = {"gpu_hours": 0.0, "cpu_hours": 0.0, "jobs": 0, "by_type": {}}
    series: dict[str, list] = {}

    for r in _rows(days):
        a, b = _span(r, since, now)
        if b <= a:
            continue
        secs = b - a
        gh = r["gpus"] * secs / 3600.0
        folder = groups.resolve(r["id"], r["name"], snap) or "(未分组)"

        f = folders.setdefault(folder, {
            "folder": folder, "jobs": 0, "gpu_hours": 0.0, "cpu_hours": 0.0,
            "wall_hours": 0.0, "running": 0, "by_type": {}, "by_state": {},
            "names": {}, "last": None,
        })
        f["jobs"] += 1
        f["gpu_hours"] += gh
        f["cpu_hours"] += r["cpus"] * secs / 3600.0
        f["wall_hours"] += secs / 3600.0
        if r["state"] == "RUNNING":
            f["running"] += 1
        if r["gpus"]:
            f["by_type"][r["gpu_type"]] = f["by_type"].get(r["gpu_type"], 0.0) + gh
            total["by_type"][r["gpu_type"]] = total["by_type"].get(r["gpu_type"], 0.0) + gh
        f["by_state"][r["state"]] = f["by_state"].get(r["state"], 0) + 1
        n = f["names"].setdefault(r["name"] or "(unnamed)", {"name": r["name"] or "(unnamed)",
                                                             "runs": 0, "gpu_hours": 0.0})
        n["runs"] += 1
        n["gpu_hours"] += gh
        f["last"] = max(f["last"] or 0, b)

        total["gpu_hours"] += gh
        total["cpu_hours"] += r["cpus"] * secs / 3600.0
        total["jobs"] += 1

        # spread the job's GPU-hours over the days it actually occupied
        s = series.setdefault(folder, [0.0] * ndays)
        t = a
        while t < b:
            d = int(t // _DAY)
            nxt = min((d + 1) * _DAY, b)
            i = d - day0
            if 0 <= i < ndays:
                s[i] += r["gpus"] * (nxt - t) / 3600.0
            t = nxt

    out = []
    for name, f in folders.items():
        f["by_type"] = dict(sorted(f["by_type"].items(), key=lambda kv: -kv[1]))
        f["top_names"] = sorted(f.pop("names").values(),
                                key=lambda n: -n["gpu_hours"])[:8]
        f["series"] = [round(x, 3) for x in series.get(name, [0.0] * ndays)]
        for k in ("gpu_hours", "cpu_hours", "wall_hours"):
            f[k] = round(f[k], 2)
        f["by_type"] = {k: round(v, 2) for k, v in f["by_type"].items()}
        for n in f["top_names"]:
            n["gpu_hours"] = round(n["gpu_hours"], 2)
        out.append(f)
    out.sort(key=lambda f: -f["gpu_hours"])

    daily = [round(sum(series[k][i] for k in series), 3) for i in range(ndays)]
    return {
        "days": days,
        "since": since,
        "day0": day0 * _DAY,
        "total": {"gpu_hours": round(total["gpu_hours"], 2),
                  "cpu_hours": round(total["cpu_hours"], 2),
                  "jobs": total["jobs"],
                  "by_type": {k: round(v, 2) for k, v in
                              sorted(total["by_type"].items(), key=lambda kv: -kv[1])}},
        "folders": out,
        "daily": daily,
    }
