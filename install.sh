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

# Ollama (OS-specific bootstrap; install-common pulls the model)
if ! command -v ollama >/dev/null 2>&1; then
  echo "[install] Installing Ollama…"
  if [[ "$(uname -s)" == "Darwin" ]]; then brew install ollama
  else curl -fsSL https://ollama.com/install.sh | sh
  fi
fi

exec node scripts/install-common.mjs
