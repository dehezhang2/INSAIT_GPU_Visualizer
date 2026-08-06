# GPU Visualizer

A zero-dependency Slurm WebUI that **separates job definition from job
management**: you declare jobs in each project repo's `gpuviz.toml`, register the
repos here, and then submit / monitor / migrate / read logs for all of them from
one page — alongside a live map of free GPUs across the cluster.

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
  repo A ─┐   each repo's gpuviz.toml          WebUI (here)         Slurm
  repo B ─┼─► declares its jobs (resources,  ─►  · free-GPU map  ─►  sbatch
  repo C ─┘   command, data deps)                · submit + overrides  scancel
                                                 · make-before-break   scontrol
                                                 · logs / migrations
```

Define jobs **once, in the repo** (version-controlled, next to the code). Manage
them **here**. GUI tweaks at submit time don't rewrite your `gpuviz.toml`; the
exact sbatch that ran is snapshotted into `<repo>/.gpuviz/submissions/`.

## Features

**Cluster GPU map** — every GPU node grouped by type (h200 / a6000 / …); one cell
per GPU, green = free. Nodes you can submit to are highlighted, others dimmed 🔒.
Header shows free-by-type. Filters + adjustable refresh interval.

**Projects** — register a repo → its `gpuviz.toml` jobs appear as blocks (sized by
GPU count). Each shows its **data-dependency status** (`needs`): ✓ present /
⚠ too small / ✗ missing / ⇄ on another site. *Preview / submit* opens an override
form (live sbatch preview, `?` explains every flag, **QOS picker shows priority**,
**⚡ max-schedulability** button clears nodelist + any-GPU + multi-partition).

**Jobs** — your running/pending jobs. Per job: **logs** (drill-in stdout/stderr
viewer with live tail), hold/release, edit (`scontrol update`), cancel. Jobs
submitted from a repo are tagged with their origin.

**Make-before-break migration** — drag a running job onto a free node: a clone is
submitted there and the original is cancelled **only once the clone is RUNNING**
(no allocation gap). A background thread watches it; abort anytime (keeps the
original). `swap→` on a running job does the same but hands the node to a chosen
catalog job (e.g. holder → real eval).

**Ad-hoc** — one-off jobs not tied to a repo (full sbatch editor).

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

## gpuviz.toml

See [`examples/gpuviz.toml`](examples/gpuviz.toml). Supports `[defaults]` +
`[[job]]` with inline `command`, reused `script_file`, `kind="holder"`, and data
`needs` (with `min_gb` / `site`).

## Files

| file | role |
|------|------|
| `server.py`    | stdlib HTTP server + JSON API |
| `auth.py`      | password hash + sessions (`~/.gpuviz/auth.json`) |
| `slurm.py`     | nodes / jobs / qos / partitions / actions |
| `catalog.py`   | read a repo's `gpuviz.toml` |
| `projects.py`  | repo registry (`~/.gpuviz/projects.json`) |
| `submitter.py` | render + snapshot + submit + provenance index |
| `migrate.py`   | make-before-break background engine |
| `deps.py`      | data-dependency presence checks |
| `logs.py`      | resolve + tail stdout/stderr |
| `sbatch.py`    | render spec → sbatch; field help; holder template |
| `drafts.py`    | ad-hoc (non-repo) jobs |
| `static/`      | `index.html`, `style.css`, `app.js` (no build) |

## Not done yet

- **Cross-site data transfer** (feature 7): deps already *detect* `site=` data
  that lives on another cluster (sof1/msp3/hala/gcp don't share `/scratch`, and
  `/group` is Ceph) and flag ⇄ "stage first" — but the actual transfer + progress
  bar isn't built. Needs the storage topology confirmed (is `/group` the same
  Ceph everywhere?) and a transfer mechanism (rsync between login nodes? object
  store?).
- Live submit/migrate were left **untested against real jobs** by design; do a
  guarded end-to-end run with a tiny holder job first.

State lives in `~/.gpuviz/` (projects, drafts, submission index). Migrations are
in-memory (lost on server restart).
