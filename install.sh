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

# Keep in sync with installer NodeBootstrap.cs NODE_FALLBACK_VERSION and
# desktop/src/node-runtime.ts MANAGED_NODE_VERSION.
NODE_VER="24.16.0"

if [[ "$(uname -s)" == "Darwin" ]]; then
  # Provision the app-owned official Node into ~/.lax/runtime and put it first
  # on PATH. brew's node is ad-hoc signed, so its macOS TCC grants die on every
  # `brew upgrade` (see desktop/src/node-runtime.ts); the official build is
  # self-contained + Developer-ID signed, so the runtime stays stable. brew is
  # the fallback only if this download fails.
  RT="$HOME/.lax/runtime"
  if [[ ! -x "$RT/bin/node" ]] || [[ "$(cat "$RT/.node-version" 2>/dev/null)" != "$NODE_VER" ]]; then
    ARCH="$([[ "$(uname -m)" == "arm64" ]] && echo arm64 || echo x64)"
    PKG="node-v${NODE_VER}-darwin-${ARCH}"
    echo "[install] Provisioning Node ${NODE_VER} (${PKG})…"
    if curl -fsSL "https://nodejs.org/dist/v${NODE_VER}/${PKG}.tar.gz" -o "/tmp/${PKG}.tar.gz"; then
      { rm -rf "$RT" && mkdir -p "$RT" \
        && tar -xzf "/tmp/${PKG}.tar.gz" -C "$RT" --strip-components=1 \
        && echo "$NODE_VER" > "$RT/.node-version"; } || echo "[install] managed Node provision failed — falling back"
      rm -f "/tmp/${PKG}.tar.gz" || true
    fi
  fi
  if [[ -x "$RT/bin/node" ]]; then export PATH="$RT/bin:$PATH"; fi
fi

# Fallback bootstrap: if no usable node is on PATH yet (managed provision failed,
# or Linux), install one so install-common.mjs can run.
if ! command -v node >/dev/null 2>&1 || [[ "$(node -v | sed 's/v//;s/\..*//')" -lt 22 ]]; then
  echo "[install] Installing Node 24 (LTS)…"
  if [[ "$(uname -s)" == "Darwin" ]]; then
    command -v brew >/dev/null 2>&1 || /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
    brew install node@24 && brew link --overwrite --force node@24
  else
    curl -fsSL https://deb.nodesource.com/setup_24.x | sudo -E bash -
    sudo apt-get install -y nodejs
  fi
fi

exec node scripts/install-common.mjs "$@"
