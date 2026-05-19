#!/usr/bin/env bash
# Local Agent X — macOS/Linux installer (thin wrapper).
# Cross-OS install logic lives in scripts/install-common.mjs.
set -euo pipefail
cd "$(dirname "$0")"

# Node 22+ (OS-specific bootstrap)
if ! command -v node >/dev/null 2>&1 || [[ "$(node -v | sed 's/v//;s/\..*//')" -lt 22 ]]; then
  echo "[install] Installing Node 22…"
  if [[ "$(uname -s)" == "Darwin" ]]; then
    command -v brew >/dev/null 2>&1 || /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
    brew install node@22 && brew link --overwrite --force node@22
  else
    curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
    sudo apt-get install -y nodejs
  fi
fi

# C++ toolchain — required when an npm dependency falls back to source build.
# macOS: Xcode Command Line Tools (clang/llvm). Linux: build-essential.
if [[ "$(uname -s)" == "Darwin" ]]; then
  if ! xcode-select -p >/dev/null 2>&1; then
    echo "[install] Installing Xcode Command Line Tools…"
    xcode-select --install || true
    echo "[install] A system dialog opened — click 'Install' and accept the license."
    echo "[install] When the CLT install finishes, re-run this installer."
    exit 0
  fi
elif [[ "$(uname -s)" == "Linux" ]]; then
  if ! command -v gcc >/dev/null 2>&1; then
    echo "[install] Installing build-essential…"
    sudo apt-get install -y build-essential
  fi
fi

# Python 3 — optional voice servers + user scripts. macOS: brew install. Linux:
# preinstalled on most distros; install python3-pip if missing.
if [[ "$(uname -s)" == "Darwin" ]] && ! command -v python3 >/dev/null 2>&1; then
  echo "[install] Installing Python 3.12 via brew…"
  brew install python@3.12
elif [[ "$(uname -s)" == "Linux" ]] && ! command -v python3 >/dev/null 2>&1; then
  echo "[install] Installing Python 3…"
  sudo apt-get install -y python3 python3-pip
fi

# Ollama (OS-specific bootstrap; install-common pulls the model)
if ! command -v ollama >/dev/null 2>&1; then
  echo "[install] Installing Ollama…"
  if [[ "$(uname -s)" == "Darwin" ]]; then brew install ollama
  else curl -fsSL https://ollama.com/install.sh | sh
  fi
fi

exec node scripts/install-common.mjs
