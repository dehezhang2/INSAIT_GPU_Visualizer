"""sbatch generation + attribute help.

A "draft" is a structured description of a job (name, #gpus, gpu type, time,
partition, nodelist, script body, ...). We render it to a real sbatch file on
demand, so the GUI never has to expose raw #SBATCH syntax unless the user wants
it. FIELD_HELP backs the inline "?" explanations in the editor.
"""
from __future__ import annotations

# Human explanations for each editable field, surfaced as "?" tooltips.
# Keep these short and practical — they are read at a glance.
FIELD_HELP: dict[str, dict] = {
    "name": {
        "flag": "--job-name / -J",
        "what": "任务名,会显示在 squeue 里。只影响可读性,不影响调度。",
        "example": "sft_internvl_aug",
    },
    "project": {
        "flag": "(仅 GUI,非 sbatch 参数)",
        "what": "提交后任务归入 Jobs 页的哪个 project 文件夹。留空=未分组,之后也可拖动归类。",
        "example": "conesplat",
    },
    "workdir": {
        "flag": "--chdir / -D",
        "what": "任务的工作目录(相对路径的 output / 脚本都以它为基准)。留空=家目录。",
        "example": "/home/me/projects/myrepo",
    },
    "gpus": {
        "flag": "--gres=gpu:N",
        "what": "每个节点要几张 GPU。配合 gpu_type 会变成 --gres=gpu:<type>:N。",
        "example": "4",
    },
    "gpu_type": {
        "flag": "--gres=gpu:<type>:N",
        "what": "指定 GPU 型号(如 h200 / a6000)。留空则任意型号,排队更快但可能拿到慢卡。",
        "example": "h200",
    },
    "nodes": {
        "flag": "--nodes / -N",
        "what": "要几个节点。多机训练才 >1;单机推理/eval 用 1。",
        "example": "1",
    },
    "cpus": {
        "flag": "--cpus-per-task / -c",
        "what": "每个 task 的 CPU 核数。给 dataloader 留够,常见 8~16/卡。",
        "example": "12",
    },
    "mem": {
        "flag": "--mem",
        "what": "每节点内存。可写 0 表示用满节点全部内存。",
        "example": "128G",
    },
    "time": {
        "flag": "--time / -t",
        "what": "墙钟时限,到点强杀。写小一点更容易被 backfill 提前调度。",
        "example": "8:00:00",
    },
    "partition": {
        "flag": "--partition / -p",
        "what": "提交到哪个分区。不同分区对应不同节点池/抢占策略。",
        "example": "batch",
    },
    "qos": {
        "flag": "--qos / -q",
        "what": "服务质量等级,影响优先级/抢占/资源上限。",
        "example": "normal",
    },
    "account": {
        "flag": "--account / -A",
        "what": "计费账户。一般用默认,跨项目时才改。",
        "example": "bggpt",
    },
    "nodelist": {
        "flag": "--nodelist / -w",
        "what": "硬指定跑在哪些节点上(逗号分隔)。拖拽到空闲节点时会填这里。",
        "example": "sof1-h200-3",
    },
    "exclude": {
        "flag": "--exclude / -x",
        "what": "排除某些节点。避开坏卡/慢节点时用。",
        "example": "msp3-1",
    },
    "open_mode": {
        "flag": "--open-mode",
        "what": "日志写入方式:append 追加,truncate 覆盖。",
        "example": "append",
    },
    "output": {
        "flag": "--output / -o",
        "what": "stdout 日志路径。%j=jobid,%x=任务名,%a=数组任务号。",
        "example": "logs/slurm-%x-%j.out",
    },
    "array": {
        "flag": "--array / -a",
        "what": "数组作业,一次投多个。0-7 投 8 个;0-15%4 限制最多同时 4 个在跑。",
        "example": "0-7%4",
    },
    "script": {
        "flag": "(脚本主体)",
        "what": "真正执行的命令。环境激活、训练/推理命令都写这里。",
        "example": "srun python train.py",
    },
}


# Defaults for a fresh draft.
def new_draft_defaults() -> dict:
    return {
        "name": "my-job",
        "gpus": 1,
        "gpu_type": "h200",
        "nodes": 1,
        "cpus": 12,
        "mem": "0",
        "time": "8:00:00",
        "partition": "batch",
        "qos": "",
        "account": "",
        "nodelist": "",
        "exclude": "",
        "array": "",
        "open_mode": "append",
        "output": "logs/slurm-%x-%j.out",
        "script": (
            "set -euo pipefail\n"
            "echo \"running on $(hostname), GPUs=$CUDA_VISIBLE_DEVICES\"\n"
            "nvidia-smi\n"
            "# TODO: your command here, e.g.\n"
            "# srun python train.py --foo bar\n"
        ),
    }


# A holder grabs the GPUs and keeps them lightly busy so it isn't flagged idle by
# util watchdogs — while staying instantly swappable for a real job. Low duty
# cycle (HOLD_BUSY seconds of work, then HOLD_IDLE seconds sleep) keeps util
# clearly non-zero without burning much power. Needs `python` with torch+CUDA on
# PATH (provide it via the job's `setup`); falls back to a plain hold otherwise.
HOLDER_SCRIPT = (
    "set -uo pipefail\n"
    "echo \"[holder] $(hostname): holding ${SLURM_GPUS_ON_NODE:-?} GPU(s), "
    "job ${SLURM_JOB_ID:-?} — swap me with a real job anytime\"\n"
    "echo \"[holder] tune util: HOLD_BUSY=${HOLD_BUSY:-0.5}s work / "
    "HOLD_IDLE=${HOLD_IDLE:-1.5}s idle, HOLD_SIZE=${HOLD_SIZE:-4096}\"\n"
    "python - <<'PYEOF' || { echo \"[holder] no torch/CUDA -> plain idle hold\"; "
    "sleep infinity; }\n"
    "import os, time\n"
    "try:\n"
    "    import torch\n"
    "    assert torch.cuda.is_available()\n"
    "except Exception:\n"
    "    raise SystemExit(1)\n"
    "n = int(os.environ.get('HOLD_SIZE', '4096'))\n"
    "busy = float(os.environ.get('HOLD_BUSY', '0.5'))\n"
    "idle = float(os.environ.get('HOLD_IDLE', '1.5'))\n"
    "devs = list(range(torch.cuda.device_count()))\n"
    "mats = {d: [torch.randn(n, n, device=f'cuda:{d}') for _ in range(2)] for d in devs}\n"
    "print(f'[holder] warming {len(devs)} GPU(s) size={n} duty={busy}/{busy+idle}', flush=True)\n"
    "while True:\n"
    "    t0 = time.time()\n"
    "    while time.time() - t0 < busy:\n"
    "        for d in devs:\n"
    "            a, b = mats[d]\n"
    "            mats[d][0] = (a @ b).clamp_(-1.0, 1.0)\n"
    "    torch.cuda.synchronize()\n"
    "    time.sleep(idle)\n"
    "PYEOF\n"
)


def holder_defaults(gpus: int = 1, gpu_type: str = "h200", time: str = "8:00:00") -> dict:
    d = new_draft_defaults()
    d.update({
        "name": "HOLDER-swap-me",
        "kind": "holder",
        "gpus": gpus,
        "gpu_type": gpu_type,
        "time": time,
        "output": "logs/holder-%x-%j.out",
        "script": HOLDER_SCRIPT,
    })
    return d


def _line(flag: str, value) -> str | None:
    if value in (None, "", "0") and flag in ("--qos", "--account", "--nodelist",
                                              "--exclude", "--array"):
        return None
    if value in (None, ""):
        return None
    return f"#SBATCH {flag}={value}"


def _body(d: dict) -> str:
    """Compose the runnable part: optional `setup` then `script` or `command`."""
    if d.get("script"):
        body = d["script"]
    elif d.get("command"):
        body = d["command"]
    elif d.get("kind") == "holder":
        body = HOLDER_SCRIPT  # catalog holder with no explicit command
    else:
        body = new_draft_defaults()["script"]
    setup = (d.get("setup") or "").strip()
    if setup:
        body = setup + "\n\n" + body
    return body


def render(draft: dict) -> str:
    """Render a draft / catalog spec dict into a complete sbatch script string."""
    d = {**new_draft_defaults(), **(draft or {})}
    gpus = int(d.get("gpus") or 1)
    gpu_type = (d.get("gpu_type") or "").strip()
    gres = f"gpu:{gpu_type}:{gpus}" if gpu_type else f"gpu:{gpus}"

    lines = ["#!/bin/bash"]
    out = [
        _line("--job-name", d.get("name")),
        _line("--chdir", d.get("workdir")),
        f"#SBATCH --gres={gres}",
        _line("--nodes", d.get("nodes")),
        _line("--cpus-per-task", d.get("cpus")),
        _line("--mem", d.get("mem")),
        _line("--time", d.get("time")),
        _line("--partition", d.get("partition")),
        _line("--qos", d.get("qos")),
        _line("--account", d.get("account")),
        _line("--nodelist", d.get("nodelist")),
        _line("--exclude", d.get("exclude")),
        _line("--array", d.get("array")),
        _line("--open-mode", d.get("open_mode")),
        _line("--output", d.get("output")),
        _line("--error", d.get("error")),
    ]
    lines.extend([x for x in out if x])
    lines.append("")
    # decide the body from the RAW spec (so a catalog holder with no explicit
    # script isn't shadowed by the default placeholder injected above), but carry
    # `setup` from the merged dict
    raw = dict(draft or {})
    raw.setdefault("setup", d.get("setup"))
    lines.append(_body(raw))
    return "\n".join(lines) + "\n"


def required_output_dir(draft: dict) -> str | None:
    """Slurm fails if the --output directory does not exist; return it so the
    server can mkdir -p before submitting."""
    import os

    out = (draft or {}).get("output") or new_draft_defaults()["output"]
    d = os.path.dirname(out)
    return d or None
