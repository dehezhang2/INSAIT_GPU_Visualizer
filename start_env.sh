#!/usr/bin/env bash
#
# Environment bootstrap for the GPU Visualizer (Slurm WebUI).
#
# This project is a ZERO-DEPENDENCY pure-Python stdlib app (see README):
# no pip installs, no node/npm, no build step. The only hard requirement is
# Python >= 3.11, because catalog.py parses gpuviz.toml with `tomllib`
# (added to the standard library in 3.11).
#
# Modeled after ~/Empathy/start_env.sh.

ENV_NAME=gpu_visual
# 3.12 is a stable >=3.11 interpreter (tomllib available).
PYTHON_VERSION=3.12.8
# Minimum interpreter the code actually needs (tomllib).
PY_MIN_MAJOR=3
PY_MIN_MINOR=11

# Guard against non-interactive shells where this variable is unset.
export MAMBA_ROOT_PREFIX="${MAMBA_ROOT_PREFIX:-/scratch/letian_shi/micromamba}"

eval "$(micromamba shell hook --shell bash)"

# Returns 0 if the active python satisfies the minimum version.
py_version_ok() {
  python - "$PY_MIN_MAJOR" "$PY_MIN_MINOR" << 'EOF' 2>/dev/null
import sys
need_major, need_minor = int(sys.argv[1]), int(sys.argv[2])
sys.exit(0 if sys.version_info[:2] >= (need_major, need_minor) else 1)
EOF
}

# If gpu_visual exists but its Python is too old for tomllib, recreate it.
# -wF: whole word + fixed string so "gpu_visual" doesn't match "gpu_visual2".
if micromamba env list | grep -qwF "$ENV_NAME"; then
  micromamba activate "$ENV_NAME"
  if ! py_version_ok; then
    ACTUAL=$(python -c "import sys; print('.'.join(map(str, sys.version_info[:3])))" 2>/dev/null || echo "<import failed>")
    echo ">>> Environment $ENV_NAME has Python $ACTUAL, need >= ${PY_MIN_MAJOR}.${PY_MIN_MINOR} (tomllib) — removing environment"
    micromamba deactivate 2>/dev/null || true
    micromamba env remove -n "$ENV_NAME" -y
  fi
fi

if ! micromamba env list | grep -qwF "$ENV_NAME"; then
    echo ">>> Creating micromamba environment: $ENV_NAME"
    micromamba create -y -n "$ENV_NAME" python="$PYTHON_VERSION"

    echo ">>> Activating environment"
    eval "$(micromamba shell hook --shell bash)"
    micromamba activate "$ENV_NAME"

    echo ">>> Upgrading pip"
    pip install --upgrade pip

    echo ">>> No third-party dependencies required (pure stdlib backend + vanilla JS frontend)."

    echo ">>> Verifying installation"
    python - << 'EOF'
import sys
# Every module the backend imports is part of the standard library.
import argparse, datetime, getpass, http.server, json, os, re, shutil
import socket, subprocess, threading, time, tomllib, traceback, urllib.parse
print("Python:", sys.version.split()[0])
print("tomllib:", "ok")
print("All stdlib imports resolved.")
EOF

    echo ">>> Environment $ENV_NAME ready."
else
    echo ">>> Environment $ENV_NAME is already installed."
    micromamba activate "$ENV_NAME"
fi

echo ">>> Active env: $ENV_NAME  ($(python -c 'import sys; print(sys.version.split()[0])'))"
echo ">>> Run the WebUI on the login node with:  python server.py --port 8770"
echo "Activated $ENV_NAME"
