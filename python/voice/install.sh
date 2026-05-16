#!/usr/bin/env bash
# Local Agent X — voice sidecar installer (macOS / Linux).
#
# Creates a Python venv at ~/.lax/python-voice/venv, installs the CPU
# wheels for faster-whisper + kokoro-onnx + onnxruntime, and downloads
# the Kokoro 82M model files.
#
# Usage from project root:
#   bash python/voice/install.sh
#
# Footprint: ~1-2 GB (CPU wheels + models). One-time setup.

set -euo pipefail

VENV_DIR="$HOME/.lax/python-voice/venv"
MODELS_DIR="$HOME/.lax/python-voice/kokoro"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REQS="$HERE/requirements-mac.txt"

echo ""
echo "==> Local Agent X — voice sidecar installer"
echo "    venv:   $VENV_DIR"
echo "    models: $MODELS_DIR"
echo ""

# 1. Verify Python (need 3.10+; faster-whisper requires it)
if ! command -v python3 >/dev/null 2>&1; then
    echo "ERROR: python3 not on PATH. Install Python 3.11+ first:" >&2
    echo "  macOS:  brew install python@3.12" >&2
    echo "  Linux:  apt install python3.12 python3.12-venv" >&2
    exit 1
fi
PYTHON_BIN="$(command -v python3)"
echo "[1/5] $($PYTHON_BIN --version)"

# 2. Create venv
if [ ! -d "$VENV_DIR" ]; then
    echo "[2/5] creating venv..."
    "$PYTHON_BIN" -m venv "$VENV_DIR"
else
    echo "[2/5] venv exists, reusing"
fi

VENV_PYTHON="$VENV_DIR/bin/python"
VENV_PIP="$VENV_DIR/bin/pip"

# 3. Upgrade pip + install requirements
echo "[3/5] upgrading pip..."
"$VENV_PYTHON" -m pip install --upgrade pip --quiet

echo "[4/5] installing voice deps (~500 MB-1 GB)..."
"$VENV_PIP" install -r "$REQS"

# 4. Download Kokoro model files
mkdir -p "$MODELS_DIR"
KOKORO_MODEL="$MODELS_DIR/model.onnx"
KOKORO_VOICES="$MODELS_DIR/voices.bin"

download() {
    local url="$1" out="$2"
    if command -v curl >/dev/null 2>&1; then
        curl -L --fail --progress-bar -o "$out" "$url"
    elif command -v wget >/dev/null 2>&1; then
        wget -q --show-progress -O "$out" "$url"
    else
        echo "ERROR: neither curl nor wget available — cannot download models" >&2
        exit 1
    fi
}

if [ ! -f "$KOKORO_MODEL" ]; then
    echo "[5/5] downloading kokoro model.onnx (~310 MB)..."
    download "https://github.com/thewh1teagle/kokoro-onnx/releases/download/model-files-v1.0/kokoro-v1.0.onnx" "$KOKORO_MODEL"
else
    echo "[5/5] kokoro model.onnx already present"
fi

if [ ! -f "$KOKORO_VOICES" ]; then
    echo "      downloading kokoro voices.bin (~26 MB)..."
    download "https://github.com/thewh1teagle/kokoro-onnx/releases/download/model-files-v1.0/voices-v1.0.bin" "$KOKORO_VOICES"
else
    echo "      kokoro voices.bin already present"
fi

# 5. Smoke test
echo ""
echo "==> smoke-testing venv..."
"$VENV_PYTHON" - <<'PY'
import sys
print("python", sys.version.split()[0])
import faster_whisper
print("faster_whisper", faster_whisper.__version__)
import kokoro_onnx
print("kokoro_onnx", kokoro_onnx.__version__)
import onnxruntime as ort
print("onnxruntime", ort.__version__, "providers:", ort.get_available_providers())
import torch
mps_ok = hasattr(torch.backends, "mps") and torch.backends.mps.is_available()
print("torch", torch.__version__, "mps:", mps_ok)
PY

echo ""
echo "==> Install OK."
echo "    Start the sidecar:"
echo "      $VENV_PYTHON python/voice/server.py"
