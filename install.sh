#!/usr/bin/env bash
# Open Agent X — macOS/Linux installer
# Usage: ./install.sh
set -euo pipefail

BLUE='\033[0;34m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; RED='\033[0;31m'; NC='\033[0m'
log()  { printf "${BLUE}[install]${NC} %s\n" "$*"; }
ok()   { printf "${GREEN}[ok]${NC} %s\n" "$*"; }
warn() { printf "${YELLOW}[warn]${NC} %s\n" "$*"; }
err()  { printf "${RED}[error]${NC} %s\n" "$*" >&2; }

OS="$(uname -s)"
REPO_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$REPO_DIR"

# ── Homebrew (macOS) ─────────────────────────────────────────
if [[ "$OS" == "Darwin" ]]; then
  if ! command -v brew >/dev/null 2>&1; then
    log "Installing Homebrew…"
    /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
    if [[ -d /opt/homebrew/bin ]]; then eval "$(/opt/homebrew/bin/brew shellenv)"; fi
  else
    ok "Homebrew present"
  fi
fi

# ── Node 22+ ─────────────────────────────────────────────────
need_node() {
  if ! command -v node >/dev/null 2>&1; then return 0; fi
  local v; v="$(node -v | sed 's/v//;s/\..*//')"
  [[ "$v" -lt 22 ]]
}
if need_node; then
  log "Installing Node 22…"
  if [[ "$OS" == "Darwin" ]]; then brew install node@22 && brew link --overwrite --force node@22
  else
    curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
    sudo apt-get install -y nodejs
  fi
else
  ok "Node $(node -v) present"
fi

# ── Ollama (required for memory embeddings) ──────────────────
if ! command -v ollama >/dev/null 2>&1; then
  log "Installing Ollama…"
  if [[ "$OS" == "Darwin" ]]; then brew install ollama
  else curl -fsSL https://ollama.com/install.sh | sh
  fi
else
  ok "Ollama present"
fi

# Start Ollama as a service (macOS) or background (Linux)
if [[ "$OS" == "Darwin" ]]; then
  if ! pgrep -x ollama >/dev/null 2>&1; then
    log "Starting Ollama service…"
    brew services start ollama >/dev/null
    for i in 1 2 3 4 5 6 7 8 9 10; do
      if curl -fs --max-time 2 http://127.0.0.1:11434/api/tags >/dev/null 2>&1; then break; fi
      sleep 1
    done
  fi
else
  if ! pgrep -x ollama >/dev/null 2>&1; then
    log "Starting Ollama (background)…"
    nohup ollama serve >/tmp/ollama.log 2>&1 &
    sleep 3
  fi
fi

# Pull embedding model
if ! ollama list 2>/dev/null | grep -q nomic-embed-text; then
  log "Pulling nomic-embed-text (~275MB)…"
  ollama pull nomic-embed-text
else
  ok "nomic-embed-text present"
fi

# ── Claude Code CLI (subscription-based Anthropic auth) ──────
if ! command -v claude >/dev/null 2>&1; then
  log "Installing Claude Code CLI…"
  npm install -g @anthropic-ai/claude-code
else
  ok "claude CLI present ($(claude --version 2>&1 | head -1))"
fi

# ── npm deps ─────────────────────────────────────────────────
if [[ ! -d node_modules ]]; then
  log "Installing npm dependencies…"
  npm install
else
  ok "node_modules present"
fi

# ── First-run defaults: avoid the stale-provider trap ────────
SAX_DIR="$HOME/.sax"
mkdir -p "$SAX_DIR"
SETTINGS="$SAX_DIR/settings.json"
if [[ ! -f "$SETTINGS" ]]; then
  log "Seeding default settings → anthropic/claude-sonnet-4-6"
  cat > "$SETTINGS" <<'JSON'
{
  "provider": "anthropic",
  "model": "claude-sonnet-4-6",
  "temperature": 0.7,
  "maxIterations": 25,
  "embeddingProvider": "ollama",
  "embeddingModel": "nomic-embed-text:latest"
}
JSON
fi

ok "Install complete."
echo
echo "Next:"
echo "  1. Get a Claude setup-token:   claude setup-token"
echo "  2. Start the server:           npm run dev"
echo "  3. Open the URL it prints (contains the auth token)"
echo "  4. Paste the setup-token in Settings → Account → Anthropic"
