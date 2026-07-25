#!/usr/bin/env bash
# Studio-Vox tier VoxCPM sidecar installer (macOS / Linux).
#
# OpenBMB's VoxCPM2 - primary voice-clone engine (won the 2026-07 listening
# bake-off against Chatterbox). On Apple Silicon torch uses MPS
# automatically; VoxCPM supports cpu/cuda/mps.
#
# Prerequisites:
#   * Python 3.12 (brew install python@3.12 / apt install python3.12)
#   * ~7 GB free disk (venv + model weights on first run)

set -euo pipefail

VENV_DIR="$HOME/.lax/python-voxcpm/venv"

# 1) Locate Python 3.12 or 3.13
PYTHON_BIN=""
for cand in python3.12 python3.13 python3; do
    if command -v "$cand" >/dev/null 2>&1; then
        ver=$("$cand" --version 2>&1)
        case "$ver" in
            "Python 3.12"*|"Python 3.13"*)
                PYTHON_BIN="$(command -v "$cand")"
                break
                ;;
        esac
    fi
done
if [ -z "$PYTHON_BIN" ]; then
    echo "ERROR: Python 3.12 or 3.13 not found." >&2
    echo "  macOS:  brew install python@3.12" >&2
    echo "  Linux:  apt install python3.12 python3.12-venv" >&2
    exit 1
fi
echo "Using $PYTHON_BIN ($($PYTHON_BIN --version))"

# 2) Create venv if missing
if [ ! -f "$VENV_DIR/bin/python" ]; then
    echo "Creating venv at $VENV_DIR..."
    "$PYTHON_BIN" -m venv "$VENV_DIR"
fi
PY="$VENV_DIR/bin/python"

# 3) pip + setuptools (py3.12 venvs ship without setuptools)
# Bootstrap uv into the venv, then use it as the installer (resolves + downloads
# all wheels before installing, so a failed resolve can't leave a half-built
# venv; far faster than pip). setuptools still needed - audio deps import
# pkg_resources.
echo "Bootstrapping uv..."
"$PY" -m pip install --upgrade uv --quiet
UV="$VENV_DIR/bin/uv"
REQS="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/requirements.txt"

# 4) voxcpm + server deps + faster-whisper (auto-transcribes reference
#    clips; VoxCPM conditions on the transcript). Default index torch is
#    CPU/MPS - fine here; the cu128 override is a Windows/Blackwell concern.
echo "Installing pinned base (voxcpm + server deps, ~2-3 GB)..."
"$UV" pip install --python "$PY" -r "$REQS"

# 5) Sanity check (set -e makes any failure fatal)
echo "Verifying install..."
"$PY" -c "import voxcpm; print('voxcpm: OK')"
"$PY" -c "import faster_whisper, fastapi, soundfile; print('server deps: OK')"
"$PY" -c "import torch; mps = hasattr(torch.backends, 'mps') and torch.backends.mps.is_available(); print('torch:', torch.__version__, 'mps:', mps)"

echo ""
echo "Studio-Vox tier installed. Start the VoxCPM sidecar with:"
echo "  $PY python/voxcpm/server.py"
