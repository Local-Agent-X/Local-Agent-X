#!/usr/bin/env bash
# fresh-state.sh — reset LAX learned state without reinstalling.
#
# Wipes ~/.lax (config, tool-policy, trust-ledger, memory, ari audit,
# chrome-profile, hooks, secrets, auth) and /tmp server logs. After this
# runs, the next `npm run dev` boots exactly like a brand-new install:
# same onboarding flow, no policy approvals, no learned trust hosts,
# empty memory, naive agent.
#
# Use this to reproduce fresh-install bugs without re-cloning the repo,
# re-pulling Ollama models, or running install.command. You preserve
# all the heavy stuff (node_modules, dist/, packages/, workspace user
# content) and reset only the per-user learned state.
#
# Flags:
#   --dry-run        : print what would be deleted, change nothing
#   --keep-secrets   : preserve secrets.json + auth.json so you don't
#                      have to re-onboard providers — useful when the
#                      bug under test is post-onboarding behavior
#   --wipe-workspace : also wipe workspace/apps/, workspace/sessions/.
#                      Default leaves workspace user content alone.
#   --yes            : skip the "type 'yes' to confirm" prompt
#
# Cross-platform: works on macOS, Linux, and Windows via Git Bash.

set -euo pipefail

DRY_RUN=false
KEEP_SECRETS=false
WIPE_WORKSPACE=false
SKIP_CONFIRM=false

for arg in "$@"; do
  case "$arg" in
    --dry-run)        DRY_RUN=true ;;
    --keep-secrets)   KEEP_SECRETS=true ;;
    --wipe-workspace) WIPE_WORKSPACE=true ;;
    --yes|-y)         SKIP_CONFIRM=true ;;
    -h|--help)
      sed -n '2,28p' "$0" | sed 's/^# \{0,1\}//'
      exit 0 ;;
    *)
      echo "Unknown flag: $arg" >&2
      echo "Usage: $0 [--dry-run] [--keep-secrets] [--wipe-workspace] [--yes]" >&2
      exit 1 ;;
  esac
done

# Resolve the LAX data dir the same way config.ts does — env-first so
# LAX_HOME / non-default installs are honored.
LAX_DIR="${HOME:-${USERPROFILE:-}}/.lax"
REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
WORKSPACE_DIR="$REPO_ROOT/workspace"

prefix="[reset]"
$DRY_RUN && prefix="[dry-run]"

# Show the user what's about to happen.
echo "$prefix Reset plan:"
echo "  LAX data dir : $LAX_DIR"
echo "  Workspace    : $WORKSPACE_DIR"
echo "  Server logs  : /tmp/lax-server.log"
echo "  Keep secrets : $KEEP_SECRETS"
echo "  Wipe apps    : $WIPE_WORKSPACE"
echo ""

if ! $SKIP_CONFIRM && ! $DRY_RUN; then
  read -r -p "Type 'yes' to proceed: " confirm
  [ "$confirm" = "yes" ] || { echo "$prefix aborted."; exit 1; }
fi

# Stop any running LAX server. We match both the dev (tsx) and prod
# (dist/index.js) launch shapes. If neither is running this is a no-op.
echo "$prefix [1/4] Stopping LAX server processes (if any)..."
if ! $DRY_RUN; then
  pkill -f "node.*src/index.ts"  2>/dev/null || true
  pkill -f "node.*dist/index.js" 2>/dev/null || true
  sleep 2
fi

# Wipe ~/.lax. With --keep-secrets, stage secrets.json + auth.json to a
# temp dir, blow away the directory, then restore the two files. The
# alternative (enumerate everything except those two) is fragile when
# new state files get added.
echo "$prefix [2/4] Wiping $LAX_DIR..."
if [ -d "$LAX_DIR" ]; then
  if $KEEP_SECRETS; then
    STAGE="$(mktemp -d)"
    [ -f "$LAX_DIR/secrets.json" ] && cp -p "$LAX_DIR/secrets.json" "$STAGE/" 2>/dev/null || true
    [ -f "$LAX_DIR/auth.json" ]    && cp -p "$LAX_DIR/auth.json"    "$STAGE/" 2>/dev/null || true
    if ! $DRY_RUN; then
      rm -rf "$LAX_DIR"
      mkdir -p "$LAX_DIR"
      [ -f "$STAGE/secrets.json" ] && cp -p "$STAGE/secrets.json" "$LAX_DIR/"
      [ -f "$STAGE/auth.json" ]    && cp -p "$STAGE/auth.json"    "$LAX_DIR/"
    fi
    rm -rf "$STAGE"
    echo "  preserved: secrets.json, auth.json"
  else
    $DRY_RUN || rm -rf "$LAX_DIR"
  fi
else
  echo "  (already absent)"
fi

# Workspace session caches always go; user content only with --wipe-workspace.
echo "$prefix [3/4] Wiping workspace session caches..."
if ! $DRY_RUN; then
  rm -rf "$WORKSPACE_DIR"/.session-* 2>/dev/null || true
  rm -rf "$WORKSPACE_DIR"/sessions    2>/dev/null || true
fi
if $WIPE_WORKSPACE; then
  echo "  --wipe-workspace: also removing workspace/apps/"
  $DRY_RUN || rm -rf "$WORKSPACE_DIR"/apps 2>/dev/null || true
fi

# /tmp logs — purely informational, but a clean log makes the next boot
# much easier to read.
echo "$prefix [4/4] Wiping /tmp server logs..."
$DRY_RUN || rm -f /tmp/lax-server.log 2>/dev/null || true

echo ""
echo "$prefix Done. Next \`npm run dev\` boots as a fresh install."
$DRY_RUN && echo "$prefix (DRY RUN — nothing was actually deleted)"
