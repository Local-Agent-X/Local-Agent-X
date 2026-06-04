#!/usr/bin/env bash
# Studio-Trained (GPT-SoVITS) installer (macOS / Linux).
#
# Mirrors install.ps1 minus Windows-specific AV mitigation. On Mac/Linux,
# pip wheels aren't deleted mid-extract by Defender so we don't need the
# artifact-URL fallback or the multi-layer recovery logic.
#
# Still preserved from the Windows version:
#   - pyopenjtalk / source-opencc filter (also fail on Mac without CMake +
#     a C++ toolchain in the right state)
#   - Verify-imports pass after install (the only honest "did it work?")
#   - Idempotent re-runs

set -euo pipefail

REPO_DIR="$HOME/.lax/sovits/repo"
VENV_DIR="$HOME/.lax/sovits/venv"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SERVER_REQS="$HERE/server-requirements.txt"
UPSTREAM_REQS="$REPO_DIR/requirements.txt"

# Critical modules that must import after install. Pip's exit code isn't
# enough — pip rolls back a batch when one source-build dep fails, but
# only an import proves the venv is actually usable.
VERIFY_IMPORTS=(
    torch torchaudio fastapi uvicorn httpx soundfile numpy
    tqdm librosa transformers pydantic gradio funasr
)

step() { echo "[install] $*"; }
err()  { echo "[install] $*" >&2; }

# ── Pre-flight: repo must exist ────────────────────────────────────────────
step "Checking GPT-SoVITS repo at $REPO_DIR..."
if [ ! -d "$REPO_DIR" ]; then
    err "GPT-SoVITS repo not found."
    echo ""
    echo "This installer rebuilds the Python venv on top of an existing"
    echo "GPT-SoVITS checkout. The repo + pretrained models + your trained"
    echo "voices are expected at:"
    echo "  $REPO_DIR"
    echo ""
    echo "Fresh-setup options:"
    echo "  1. Run the training pipeline (Settings -> Voice -> Train a voice)"
    echo "  2. Or clone manually:"
    echo "     git clone https://github.com/RVC-Boss/GPT-SoVITS \"$REPO_DIR\""
    echo "     Then re-run this installer."
    exit 1
fi

# ── Locate system Python (3.10 / 3.11 preferred) ───────────────────────────
PYTHON_BIN=""
for cand in python3.11 python3.10 python3.12 python3; do
    if command -v "$cand" >/dev/null 2>&1; then
        PYTHON_BIN="$(command -v "$cand")"
        break
    fi
done
if [ -z "$PYTHON_BIN" ]; then
    err "Python not found on PATH."
    echo "Install Python 3.11 from https://www.python.org/downloads/ (or brew/apt)."
    exit 1
fi
step "Python: $PYTHON_BIN ($($PYTHON_BIN --version))"

# ── Create or reuse venv ───────────────────────────────────────────────────
VENV_PYTHON="$VENV_DIR/bin/python"
if [ ! -f "$VENV_PYTHON" ]; then
    step "Creating venv at $VENV_DIR..."
    "$PYTHON_BIN" -m venv "$VENV_DIR"
else
    step "Venv exists, reusing."
fi

# ── Pick torch wheel index ─────────────────────────────────────────────────
# Mac → default index (MPS via the standard wheel). Linux with NVIDIA →
# cu126. Linux without NVIDIA → cpu. LAX_FORCE_CPU_TORCH=1 forces the cpu
# wheel on the Linux CUDA branch (CI builds the CPU-only artifact this way).
TORCH_INDEX=""
case "$(uname -s)" in
    Darwin)
        TORCH_INDEX=""  # default index; torch ships MPS in the standard wheel
        ;;
    Linux)
        if [ "$LAX_FORCE_CPU_TORCH" = "1" ]; then
            TORCH_INDEX="https://download.pytorch.org/whl/cpu"
        elif command -v nvidia-smi >/dev/null 2>&1 && nvidia-smi >/dev/null 2>&1; then
            TORCH_INDEX="https://download.pytorch.org/whl/cu126"
        else
            TORCH_INDEX="https://download.pytorch.org/whl/cpu"
        fi
        ;;
esac
step "Torch index: ${TORCH_INDEX:-(default / MPS)}"

# ── Upgrade pip ────────────────────────────────────────────────────────────
step "Upgrading pip..."
"$VENV_PYTHON" -m pip install --upgrade pip --quiet

# ── Install torch first (must precede upstream requirements.txt) ───────────
# Pin torch/torchaudio to 2.6.0 — same as install.ps1. 2.6.0 is the newest
# build before torchaudio dropped its soundfile/sox backends for torchcodec
# (which needs system FFmpeg libs), and it's the oldest build that ships cu126
# wheels — so it matches the cu126 index selected above. torch 2.5.1 has no
# cu126 wheel, which is why the previous pin failed on the Linux NVIDIA path.
step "Installing torch + torchaudio 2.6.0..."
if [ -n "$TORCH_INDEX" ]; then
    "$VENV_PYTHON" -m pip install "torch==2.6.0" "torchaudio==2.6.0" --index-url "$TORCH_INDEX"
else
    "$VENV_PYTHON" -m pip install "torch==2.6.0" "torchaudio==2.6.0"
fi

# ── Filter upstream requirements (pyopenjtalk + source-opencc problems) ────
if [ -f "$UPSTREAM_REQS" ]; then
    FILTERED="$(mktemp)"
    # pyopenjtalk: builds from source via CMake; fragile on Mac without
    # the right toolchain. Users who need Japanese can manually install.
    # opencc: --no-binary forces source build, also brittle; swap for
    # opencc-python-reimplemented (pure Python).
    grep -Ev '^\s*pyopenjtalk\b|^\s*--no-binary=opencc|^\s*opencc\s*$' "$UPSTREAM_REQS" > "$FILTERED" || true
    echo "opencc-python-reimplemented" >> "$FILTERED"

    step "Installing upstream requirements.txt (pyopenjtalk + source-opencc filtered out)..."
    "$VENV_PYTHON" -m pip install -r "$FILTERED"
    rm -f "$FILTERED"
fi

if [ -f "$SERVER_REQS" ]; then
    step "Installing wrapper deps from $SERVER_REQS..."
    "$VENV_PYTHON" -m pip install -r "$SERVER_REQS"
fi

# Pin numpy back. Some upstream deps drag numpy 2.x in but GPT-SoVITS
# hard-requires numpy<2.0.
step "Pinning numpy<2.0 (GPT-SoVITS compat)..."
"$VENV_PYTHON" -m pip install "numpy<2.0" --quiet

# ── Verify-after-install ───────────────────────────────────────────────────
step "Verifying critical imports..."
IMPORT_SCRIPT="$(printf 'import %s\n' "${VERIFY_IMPORTS[@]}")"
if ! "$VENV_PYTHON" -c "$IMPORT_SCRIPT"; then
    err "Verify failed. Some packages installed but won't import."
    echo "Common cause: a source-build dep needs a C/C++ toolchain."
    echo "On macOS, install Command Line Tools: xcode-select --install"
    echo "On Linux, install build-essential + cmake."
    exit 2
fi

step "All critical imports verified."
step "DONE. Venv: $VENV_DIR"
echo "Click 'Start' in the voice picker to launch the GPT-SoVITS sidecar."
