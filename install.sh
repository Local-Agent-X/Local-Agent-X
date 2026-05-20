#!/usr/bin/env bash
# Local Agent X — macOS/Linux CLI installer (thin wrapper).
# GUI installer is the preferred path on macOS (see the .app bundle at the
# repo root). This wrapper exists for CLI users + the GUI's child-process
# invocation, which ultimately resolves to `node scripts/install-common.mjs
# --ipc`.
#
# Bootstrap is minimal: ensure Node 22+ is present (chicken-and-egg, since
# install-common.mjs needs Node to run), then hand off. All other install
# steps (Xcode CLT, Python, Ollama, npm install, model pull, build, .app
# bundle, /Applications copy) now live in scripts/install-common.mjs so a
# single source of truth covers both CLI and GUI flows.
set -euo pipefail
cd "$(dirname "$0")"

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

exec node scripts/install-common.mjs "$@"
