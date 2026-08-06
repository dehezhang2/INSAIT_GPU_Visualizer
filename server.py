#!/usr/bin/env python3
"""gpu-visualizer — Slurm GPU dashboard + per-repo job manager (zero deps).

Run on a login node:   python3 server.py --port 8770
Tunnel from laptop:    ssh -L 8770:localhost:8770 <login-node>
Open:                  http://localhost:8770

The WebUI separates *job definition* (declared in each project repo's
gpuviz.toml) from *job management* (submit / monitor / migrate / read logs),
done here. Pure stdlib; the frontend polls the JSON API.
"""
from __future__ import annotations

import argparse
import json
import math
import os
import re
import traceback
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, unquote, urlparse

import auth
import drafts
import groups
import logs
import migrate
import monitors
import sbatch
import slurm
import transfer
import usage

HERE = os.path.dirname(os.path.abspath(__file__))
STATIC = os.path.join(HERE, "static")


class Handler(BaseHTTPRequestHandler):
    server_version = "gpuviz/0.2"

    # -- io helpers -------------------------------------------------------
    @staticmethod
    def _sane(o):
        """Strip inf/nan (e.g. TimeLimit=UNLIMITED) — not valid JSON."""
        if isinstance(o, float) and not math.isfinite(o):
            return None
        if isinstance(o, dict):
            return {k: Handler._sane(v) for k, v in o.items()}
        if isinstance(o, (list, tuple)):
            return [Handler._sane(x) for x in o]
        return o

    def _json(self, obj, status=200, headers=()):
        body = json.dumps(self._sane(obj)).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        for k, v in headers:
            self.send_header(k, v)
        self.end_headers()
        self.wfile.write(body)

    def _redirect(self, loc):
        self.send_response(302)
        self.send_header("Location", loc)
        self.send_header("Content-Length", "0")
        self.end_headers()

    def _file(self, path):
        if not os.path.isfile(path):
            return self._json({"error": "not found"}, 404)
        ctype = {".html": "text/html; charset=utf-8",
                 ".js": "application/javascript; charset=utf-8",
                 ".css": "text/css; charset=utf-8"}.get(
            os.path.splitext(path)[1], "application/octet-stream")
        with open(path, "rb") as f:
            body = f.read()
        self.send_response(200)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def _body(self) -> dict:
        n = int(self.headers.get("Content-Length") or 0)
        if not n:
            return {}
        try:
            return json.loads(self.rfile.read(n) or b"{}")
        except json.JSONDecodeError:
            return {}

    def log_message(self, *a):
        pass

    def _wrap(self, fn):
        try:
            return fn()
        except slurm.SlurmError as e:
            return self._json({"error": str(e)}, 502)
        except FileNotFoundError as e:
            return self._json({"error": str(e)}, 400)
        except Exception as e:  # noqa: BLE001
            traceback.print_exc()
            return self._json({"error": repr(e)}, 500)

    # -- auth ---------------------------------------------------------------
    def _auth_user(self):
        if not auth.enabled():
            return slurm.USER
        return auth.session_user(auth.token_from(self.headers.get("Cookie")))

    def _guard(self, path):
        """True → request may proceed. Otherwise responds 401/302 itself."""
        if self._auth_user():
            return True
        if path.startswith("/api/"):
            self._json({"error": "authentication required"}, 401)
        else:
            self._redirect("/login")
        return False

    def _login(self, body):
        user = (body.get("username") or "").strip()
        if not auth.verify(user, body.get("password") or ""):
            return self._json({"error": "用户名或密码错误"}, 401)
        tok = auth.new_session(user)
        return self._json({"ok": True},
                          headers=[("Set-Cookie", auth.cookie(tok))])

    def _logout(self):
        auth.drop_session(auth.token_from(self.headers.get("Cookie")))
        return self._json({"ok": True},
                          headers=[("Set-Cookie", auth.cookie("", expire=True))])

    # -- GET --------------------------------------------------------------
    def do_GET(self):
        u = urlparse(self.path)
        path, q = u.path, parse_qs(u.query)
        if path == "/login":
            if self._auth_user():          # already logged in (or auth off)
                return self._redirect("/")
            return self._file(os.path.join(STATIC, "login.html"))
        if not self._guard(path):
            return
        if path in ("/", "/index.html"):
            return self._file(os.path.join(STATIC, "index.html"))
        if path.startswith("/static/"):
            safe = os.path.normpath(path[len("/static/"):]).lstrip("/")
            return self._file(os.path.join(STATIC, safe))
        return self._wrap(lambda: self._get(path, q))

    def _get(self, path, q):
        if path == "/api/state":
            jobs = slurm.my_jobs()
            fin = slurm.finished_jobs()
            g = groups.snapshot()
            for j in jobs:
                j["folder"] = groups.resolve(j["job_id"], j.get("name"), g)
            for j in fin:
                j["folder"] = groups.resolve(j["id"], j.get("name"), g)
            return self._json({
                "me": slurm.USER, "site": slurm.current_site(),
                "nodes": slurm.nodes(), "jobs": jobs, "finished": fin,
                "partitions": slurm.usable_gpu_partitions(),
                "folders": g["folders"],
            })
        if path == "/api/qos":
            return self._json({"qos": slurm.my_qos()})
        if path == "/api/queue":
            return self._queue()
        if path == "/api/usage":
            days = max(1, min(365, int((q.get("days") or ["30"])[0])))
            return self._json(usage.summary(days))
        if path == "/api/drafts":
            return self._json({"drafts": drafts.list_drafts()})
        if path == "/api/migrations":
            return self._json({"migrations": migrate.list_migrations()})
        if path == "/api/transfers":
            return self._json({"transfers": transfer.list_transfers()})
        if path == "/api/monitors":
            return self._json({"monitors": monitors.list_monitors()})
        if path == "/api/sbatch/help":
            return self._json({"help": sbatch.FIELD_HELP})
        m = re.fullmatch(r"/api/jobs/([\w\[\]%_-]+)/log", path)
        if m:
            tail = int((q.get("tail") or [str(logs.MAX_TAIL)])[0])
            paths = logs.resolve_paths(m.group(1))
            same = paths["out"] and paths["out"] == paths["err"]
            return self._json({
                "out": logs.read_tail(paths["out"], tail),
                "err": None if same else logs.read_tail(paths["err"], tail),
                "workdir": paths["workdir"],
            })
        return self._json({"error": "not found"}, 404)

    def _queue(self):
        """Cluster-wide PENDING queue, sorted by scheduling order, for the Queue
        tab. Projects out the non-serializable required/excluded node sets."""
        pend = slurm.pending_jobs()
        rows = []
        summary = {}
        for p in pend:
            reason = p["reason"]
            waiting = not (reason.startswith("JobHeld") or reason in ("Dependency", "BeginTime"))
            req = p.get("required")
            rows.append({
                "id": p["id"], "job_id": p["job_id"], "user": p["user"],
                "name": p["name"], "partition": p["partition"], "qos": p["qos"],
                "priority": p["priority"], "reason": reason, "gpus": p["gpus"],
                "gpu_type": p["gpu_type"], "submit_time": p["submit_time"],
                "sprio": p["sprio"], "waiting": waiting,
                "pinned": req is not None,
                "nodelist": sorted(req) if req else None,
                "mine": p["user"] == slurm.USER,
            })
            if p["gpus"]:
                t = p["gpu_type"] or "gpu"
                s = summary.setdefault(t, {"jobs": 0, "gpus": 0, "waiting": 0})
                s["jobs"] += 1
                s["gpus"] += p["gpus"]
                if waiting:
                    s["waiting"] += 1
        rows.sort(key=lambda x: (not x["waiting"], -(x["priority"] or 0)))
        for i, r in enumerate(rows):
            r["rank"] = i + 1 if r["waiting"] else None
        return self._json({"queue": rows, "summary": summary, "me": slurm.USER})

    # -- DELETE -----------------------------------------------------------
    def do_DELETE(self):
        u = urlparse(self.path)
        if not self._guard(u.path):
            return
        return self._wrap(lambda: self._delete(u.path, parse_qs(u.query)))

    def _delete(self, path, q):
        m = re.fullmatch(r"/api/drafts/(\d+)", path)
        if m:
            ok = drafts.delete(int(m.group(1)))
            return self._json({"ok": ok}, 200 if ok else 404)
        m = re.fullmatch(r"/api/monitors/([\w.:-]+)", path)
        if m:
            return self._json({"ok": monitors.delete(m.group(1))})
        m = re.fullmatch(r"/api/groups/(.+)", path)
        if m:
            ok = groups.delete(unquote(m.group(1)))
            return self._json({"ok": ok}, 200 if ok else 404)
        return self._json({"error": "not found"}, 404)

    # -- POST / PUT -------------------------------------------------------
    def do_POST(self):
        path = urlparse(self.path).path
        body = self._body()
        if path == "/api/login":
            return self._wrap(lambda: self._login(body))
        if not self._guard(path):
            return
        if path == "/api/logout":
            return self._wrap(self._logout)
        return self._wrap(lambda: self._post(path, body))

    def do_PUT(self):
        return self.do_POST()

    def _post(self, path, body):
        # ---- migration --------------------------------------------------
        if path == "/api/migrate":
            return self._migrate(body)
        m = re.fullmatch(r"/api/migrations/(\d+)/abort", path)
        if m:
            return self._json({"ok": migrate.abort(int(m.group(1)))})
        if path == "/api/migrations/clear":
            migrate.clear_finished()
            return self._json({"ok": True})

        # ---- cross-site data staging ------------------------------------
        if path == "/api/stage":
            host = (body.get("src_host") or "").strip()
            src = (body.get("src_path") or "").strip()
            if not host or not src:
                return self._json({"error": "src_host and src_path required"}, 400)
            t = transfer.create(host, src, body.get("dst_path") or src)
            return self._json({"transfer": t})
        m = re.fullmatch(r"/api/transfers/(\d+)/abort", path)
        if m:
            return self._json({"ok": transfer.abort(int(m.group(1)))})
        if path == "/api/transfers/clear":
            transfer.clear_finished()
            return self._json({"ok": True})

        # ---- project folders (job grouping) ------------------------------
        if path == "/api/groups":
            try:
                return self._json({"folder": groups.create(body.get("name"))})
            except ValueError as e:
                return self._json({"error": str(e)}, 400)
        if path == "/api/groups/rename":
            try:
                ok = groups.rename(body.get("old") or "", body.get("new"))
            except ValueError as e:
                return self._json({"error": str(e)}, 400)
            return self._json({"ok": ok}, 200 if ok else 404)
        if path == "/api/groups/assign":
            if not body.get("job_id"):
                return self._json({"error": "job_id required"}, 400)
            groups.assign(body["job_id"], body.get("name"), body.get("folder"))
            return self._json({"ok": True})

        # ---- external progress monitors ---------------------------------
        if path == "/api/monitors":
            try:
                return self._json({"monitor": monitors.upsert(body)})
            except ValueError as e:
                return self._json({"error": str(e)}, 400)
        if path == "/api/monitors/clear":
            return self._json({"cleared": monitors.clear_finished()})

        # ---- job templates (the submit path) ----------------------------
        if path == "/api/drafts":
            kind = body.pop("kind", "normal")
            return self._json({"draft": drafts.create(body, kind=kind)})
        m = re.fullmatch(r"/api/drafts/(\d+)", path)
        if m:
            d = drafts.update(int(m.group(1)), body)
            return self._json({"draft": d}, 200 if d else 404)
        m = re.fullmatch(r"/api/drafts/(\d+)/submit", path)
        if m:
            return self._submit_draft(int(m.group(1)))
        if path == "/api/preview":
            return self._json({"sbatch": sbatch.render(body)})

        # ---- real job actions -------------------------------------------
        m = re.fullmatch(r"/api/jobs/([\w\[\]%_-]+)/(cancel|hold|release)", path)
        if m:
            getattr(slurm, m.group(2))(m.group(1))
            return self._json({"ok": True, "job": m.group(1), "action": m.group(2)})
        m = re.fullmatch(r"/api/jobs/([\w\[\]%_-]+)/update", path)
        if m:
            fields = {k: v for k, v in body.items() if v not in (None, "")}
            slurm.update(m.group(1), **fields)
            return self._json({"ok": True, "job": m.group(1)})

        return self._json({"error": "not found"}, 404)

    # -- migration dispatch ----------------------------------------------
    def _migrate(self, body):
        src = str(body.get("src_job_id") or "").strip()
        node = (body.get("target_node") or "").strip()
        if not src or not node:
            return self._json({"error": "src_job_id and target_node required"}, 400)
        mode = body.get("mode", "clone")

        if mode == "handoff":
            did = int(body.get("draft_id") or 0)
            tmpl = drafts.get(did)
            if not tmpl:
                return self._json({"error": "no such job template"}, 404)

            def submit_fn():
                # pin to the node for this run only — don't rewrite the template
                pinned = {**tmpl, "nodelist": node}
                path = drafts.write_sbatch_file(pinned)
                jid = slurm.submit(path, workdir=pinned.get("workdir")
                                   or os.path.expanduser("~"))
                drafts.mark_submitted(did, jid)
                if pinned.get("project"):
                    groups.assign(jid, pinned.get("name"), pinned["project"])
                return jid

            label = f"handoff {tmpl.get('name') or did} → {node} (replace {src})"
        else:  # clone
            d = slurm.job_detail(src)
            if not d:
                return self._json({"error": f"job {src} not found"}, 404)
            script, workdir = d.get("command"), d.get("workdir") or os.path.expanduser("~")
            if not script or not os.path.isfile(script):
                return self._json({"error": "原任务脚本不可读,无法克隆迁移;可用 handoff 模式选一个任务模板"}, 400)
            extra = ["--nodelist=" + node]
            if body.get("partition"):
                extra.append("--partition=" + body["partition"])

            def submit_fn():
                return slurm.submit(script, extra_args=extra, workdir=workdir)

            label = f"clone {d.get('name') or src} → {node}"

        m = migrate.create(src, node, submit_fn, label=label)
        return self._json({"migration": m})

    def _submit_draft(self, did):
        d = drafts.get(did)
        if not d:
            return self._json({"error": "no such draft"}, 404)
        outdir = sbatch.required_output_dir(d)
        workdir = d.get("workdir") or os.path.expanduser("~")
        if outdir:
            tgt = outdir if os.path.isabs(outdir) else os.path.join(workdir, outdir)
            os.makedirs(tgt, exist_ok=True)
        path = drafts.write_sbatch_file(d)
        job_id = slurm.submit(path, workdir=workdir)
        drafts.mark_submitted(did, job_id)
        if d.get("project"):
            groups.assign(job_id, d.get("name"), d["project"])
        return self._json({"ok": True, "job_id": job_id})


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--port", type=int, default=8770)
    ap.add_argument("--host", default="127.0.0.1")
    ap.add_argument("--set-password", action="store_true",
                    help="create/update login credentials and exit")
    ap.add_argument("--no-auth", action="store_true",
                    help="run WITHOUT login (anyone on this host can act as you)")
    args = ap.parse_args()
    if args.set_password:
        auth.set_password()
        return
    if args.no_auth:
        auth.disable()
    elif not auth.configured():
        raise SystemExit(
            "no credentials yet — run `python3 server.py --set-password` first\n"
            "(or start with --no-auth, NOT recommended on a shared login node)")
    httpd = ThreadingHTTPServer((args.host, args.port), Handler)
    print(f"gpu-visualizer — user '{slurm.USER}' @ site '{slurm.current_site()}'")
    print("  auth:   " + ("OFF (--no-auth)" if args.no_auth
                          else f"login required ({auth.AUTH_FILE})"))
    print(f"  local:  http://{args.host}:{args.port}")
    print(f"  tunnel: ssh -L {args.port}:localhost:{args.port} <this-login-node>")
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print("\nbye")


if __name__ == "__main__":
    main()
