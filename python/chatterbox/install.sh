#!/usr/bin/env bash
# Studio tier Chatterbox sidecar installer (macOS / Linux).
#
# Resemble AI's Chatterbox (chatterbox-streaming variant) — single-stage
# TTS with reference-clip voice cloning. Lives in its own venv to avoid
# torch version conflicts with the Lite voice sidecar.
#
# Prerequisites:
#   * Python 3.12 (brew install python@3.12 / apt install python3.12)
#   * ~6 GB free disk
#
# On Apple Silicon, torch uses MPS automatically. On Intel Mac / Linux
# without a GPU, falls back to CPU (slower).

set -euo pipefail

VENV_DIR="$HOME/.lax/python-chatterbox/venv"

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

# 3) Upgrade pip
echo "Upgrading pip..."
"$PY" -m pip install --upgrade pip --quiet

# 4) Install chatterbox-streaming. CPU/MPS torch is the default index — no
#    cu128 wheel index like Windows. Apple Silicon gets MPS automatically;
#    Intel/Linux without a GPU falls back to CPU.
echo "Installing chatterbox-streaming (~1-2 GB of torch wheels)..."
"$PY" -m pip install chatterbox-streaming

# 5) FastAPI runtime + audio helpers (usually already pulled in)
"$PY" -m pip install fastapi "uvicorn[standard]" soundfile

# 6) Sanity check
echo "Verifying install..."
"$PY" -c "import chatterbox; print('chatterbox: OK')"
"$PY" -c "import torch; mps = hasattr(torch.backends, 'mps') and torch.backends.mps.is_available(); print('torch:', torch.__version__, 'mps:', mps)"

echo ""
echo "Studio tier installed. Start the Chatterbox sidecar with:"
echo "  $PY python/chatterbox/server.py"
