# GPU Visualizer

A zero-dependency Slurm WebUI: submit / monitor / migrate / read logs for your
jobs, organize them into **project folders** you drag jobs into, see **how many
GPU-hours each project burned** — all next to a live map of free GPUs across the
cluster.

Pure Python **stdlib** backend + vanilla JS frontend. No pip installs, no
node/npm, no build step.

## Run

On the Slurm **login node**:

```bash
python3 server.py --set-password   # first time only: create login credentials
python3 server.py --port 8770
```

From your laptop:

```bash
ssh -L 8770:localhost:8770 <login-node>      # e.g. sof1-h200-0
# open http://localhost:8770
```

## Concept

```
   Templates          Jobs (folders)         Usage            Slurm
   reusable      ─►   drag a job into   ─►   GPU-hours   ◄──  sbatch / scancel
   sbatch specs       its project            per project      scontrol / sacct
```

Everything is organized around a **project label** you control from the GUI, not
around config files in your repos. Submit from a reusable template (which can
carry a project), or drag any job — however it was submitted, including from
your own shell — into a folder. Labels are pure metadata: nothing about the
Slurm job changes, and the same labels drive the per-project usage accounting.

## Features

**Cluster GPU map** — every GPU node grouped by type (h200 / a6000 / …); one cell
per GPU, green = free. Nodes you can submit to are highlighted, others dimmed 🔒.
Header shows free-by-type. Filters + adjustable refresh interval.

**Jobs — project folders** — your running/pending jobs, grouped into folders you
create in the GUI: drag a job card onto a folder header to file it, drag onto
未分组 to unfile. Filing is **sticky by job name**, so the next run of the same
job lands in the same folder without touching it. Jobs submitted from a template
carrying a `project` are filed on submit. Folders are labels only — nothing about
the Slurm job changes, and jobs you submitted from your own shell can be filed
just the same. Per job: **logs** (drill-in stdout/stderr viewer with live tail),
**info**, hold/release, edit (`scontrol update`), cancel. No folders created ⇒
the tab stays a flat list.

**Usage** — GPU-hours per project over the last 7 / 30 / 90 / 180 days, read from
`sacct` and attributed with the same folder rules. Stacked bars break each
project down by GPU type, a daily sparkline shows the trend, and expanding a row
lists the job names that burned the time (runs + GPU-h each) plus the
COMPLETED/FAILED/… mix. A job that straddles the window edge only counts the
part inside it, and long jobs are spread across the days they actually occupied.

**Templates** — reusable sbatch specs (full editor with live preview, `?` on
every flag, **QOS picker showing priority**, **⚡ max-schedulability** button that
clears nodelist + any-GPU + multi-partition). `clone` copies one to tweak,
`Project` files its submissions automatically, `+ Holder` makes a GPU-warming
placeholder. Drag a template onto a free node to pin `--nodelist`, or onto a
project folder to set its project.

**Make-before-break migration** — drag a running job onto a free node: a clone is
submitted there and the original is cancelled **only once the clone is RUNNING**
(no allocation gap). A background thread watches it; abort anytime (keeps the
original). `swap→` on a running job does the same but hands the node to a chosen
**template** (e.g. holder → real eval); the template itself is not rewritten.

**Finished** — a job that reaches a terminal state leaves **Jobs** and lands here
with its real outcome from `sacct` (COMPLETED / FAILED / CANCELLED / TIMEOUT +
exit code + elapsed). Read-only: `logs` still works while Slurm remembers the
job, `swap→` is disabled — you cannot hand off a node that is already released.
Each card self-clears 3 minutes after the job ended (`clear` / `dismiss` to drop
it sooner); cleared cards never come back.

## Authentication

Binding to `127.0.0.1` does **not** protect a shared login node: every user on
the same host can reach localhost, and the API runs Slurm commands as whoever
started the server. So the UI requires a login (username + password).

- `python3 server.py --set-password` — create/update credentials
  (PBKDF2-SHA256, stored 0600 in `~/.gpuviz/auth.json`).
- Sessions are HttpOnly cookies backed by in-memory tokens (7-day sliding
  expiry; a server restart logs everyone out).
- `--no-auth` skips the login — only for single-user machines.

## Why QOS matters on this cluster (and "spread across nodes" doesn't)

Scheduling is `sched/backfill` with `PriorityWeightQOS` ≈ 1e9, dwarfing age /
fairshare. So **which QOS you submit under dominates start time** far more than
how many nodes you target. Submitting many node-pinned copies is *worse* than one
unconstrained job (pinning defeats backfill, risks double-starts). The right
"queue everywhere" is one job: no nodelist, any GPU type, multi-partition,
**tight `--time`** — that's the ⚡ max-schedulability button.

## Files

| file | role |
|------|------|
| `server.py`    | stdlib HTTP server + JSON API |
| `auth.py`      | password hash + sessions (`~/.gpuviz/auth.json`) |
| `slurm.py`     | nodes / jobs / qos / partitions / actions |
| `groups.py`    | project folders for jobs (`~/.gpuviz/groups.json`) |
| `usage.py`     | per-project GPU-hour accounting from `sacct` |
| `drafts.py`    | reusable job templates (`~/.gpuviz/drafts.json`) |
| `sbatch.py`    | render spec → sbatch; field help; holder template |
| `migrate.py`   | make-before-break background engine |
| `transfer.py`  | rsync staging between login nodes |
| `monitors.py`  | external progress monitors (posted by training scripts) |
| `logs.py`      | resolve + tail stdout/stderr |
| `static/`      | `index.html`, `login.html`, `style.css`, `app.js` (no build) |

## Notes

The old **`gpuviz.toml` repo-catalog** mechanism (register a repo → read its
declared jobs → submit with overrides) was removed: in practice it went unused
(the submission index stayed empty while the repo registry went stale), and its
job-organizing role is now done better by GUI folders, which also cover jobs
submitted outside this tool. Templates replaced it as the submit path. To bring
it back, see the commit that deleted `catalog.py` / `projects.py` /
`submitter.py` / `deps.py`.

State lives in `~/.gpuviz/` (credentials, folders, templates). Migrations and
sessions are in memory — a server restart drops both.
