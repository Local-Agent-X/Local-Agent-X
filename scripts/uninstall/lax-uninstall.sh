#!/usr/bin/env bash
# Local Agent X - standalone uninstaller (macOS / Linux).
#
# Companion to lax-uninstall.ps1 and the same contract: this file is BOTH the
# uninstaller the installer registers AND the rescue script a stuck user can
# download and run on its own. Self-contained by design - no Node, no npm, no
# repo checkout, no working Local Agent X install, and no working update system
# are required, because a user whose install is broken cannot receive a fix
# through the updater.
#
# Usage (interactive):   bash lax-uninstall.sh
# Usage (keep data):     bash lax-uninstall.sh --yes
# Usage (factory reset): bash lax-uninstall.sh --yes --delete-data
# Usage (preview only):  bash lax-uninstall.sh --dry-run

set -u

DELETE_DATA=0
ASSUME_YES=0
DRY_RUN=0
for arg in "$@"; do
  case "$arg" in
    --delete-data) DELETE_DATA=1 ;;
    --yes|-y)      ASSUME_YES=1 ;;
    --dry-run)     DRY_RUN=1 ;;
    --help|-h)
      sed -n '2,16p' "$0" | sed 's/^# \{0,1\}//'
      exit 0 ;;
    *) echo "unknown option: $arg" >&2; exit 2 ;;
  esac
done

LAX_DIR="$HOME/.lax"
REMOVED=()
SKIPPED=()

# --- Safety ------------------------------------------------------------------
# A wrong path here deletes someone's source tree. Removal is gated on a
# sentinel check plus a hard refusal to touch anything holding a .git dir, so a
# developer whose projectRoot points at their own clone gets it back untouched.
is_lax_source_tree() {
  local p="$1"
  [ -f "$p/package.json" ] || return 1
  if grep -q '"name"[[:space:]]*:[[:space:]]*"local-agent-x' "$p/package.json" 2>/dev/null; then return 0; fi
  [ -f "$p/src/index.ts" ] && [ -d "$p/desktop" ]
}

remove_path() {
  local p="$1" label="$2"
  [ -n "$p" ] || return 0
  [ -e "$p" ] || return 0
  case "$p" in
    "$HOME"|"/"|"/Applications"|"/usr"|"/etc"|"/var")
      SKIPPED+=("$p (is a system or home root)"); return 0 ;;
  esac
  if [ ${#p} -lt 8 ]; then SKIPPED+=("$p (path too short to be safe)"); return 0; fi
  # Never delete a git checkout - that is a working copy, not an install
  # artifact, and it may hold uncommitted work.
  if [ -d "$p/.git" ]; then SKIPPED+=("$p (git checkout - left alone on purpose)"); return 0; fi
  if [ "$DRY_RUN" = "1" ]; then REMOVED+=("[dry-run] $label -> $p"); return 0; fi
  rm -rf "$p"
  if [ -e "$p" ]; then SKIPPED+=("$p (removal failed - permissions?)"); else REMOVED+=("$label -> $p"); fi
}

# --- Discovery ---------------------------------------------------------------
project_root() {
  [ -f "$LAX_DIR/config.json" ] || return 0
  # Deliberately not depending on python/jq being installed.
  sed -n 's/.*"projectRoot"[[:space:]]*:[[:space:]]*"\(.*\)".*/\1/p' "$LAX_DIR/config.json" | head -1
}

PROJECT_ROOT="$(project_root)"
DIRS=()
LABELS=()
add_dir() {
  local p="$1" label="$2"
  [ -n "$p" ] || return 0
  local d
  for d in ${DIRS+"${DIRS[@]}"}; do [ "$d" = "$p" ] && return 0; done
  DIRS+=("$p"); LABELS+=("$label")
}

if [ "$(uname -s)" = "Darwin" ]; then
  add_dir "/Applications/Local Agent X.app" "app bundle"
  add_dir "$HOME/Applications/Local Agent X.app" "app bundle (user)"
  add_dir "$HOME/Library/Application Support/Local Agent X" "Electron user data"
  add_dir "$HOME/Library/Application Support/electron" "Electron user data (legacy)"
  add_dir "$HOME/Library/Caches/com.localagentx.desktop" "cache"
  add_dir "$HOME/Library/Caches/Local Agent X" "cache"
else
  add_dir "$HOME/.config/Local Agent X" "Electron user data"
  add_dir "$HOME/.config/electron" "Electron user data (legacy)"
  add_dir "$HOME/.local/share/local-agent-x" "app data"
fi

if [ -n "$PROJECT_ROOT" ] && is_lax_source_tree "$PROJECT_ROOT"; then
  add_dir "$PROJECT_ROOT" "source tree (projectRoot)"
fi

FILES=()
if [ "$(uname -s)" = "Darwin" ]; then
  FILES+=("/Applications/Uninstall Local Agent X.command")
  FILES+=("$HOME/Applications/Uninstall Local Agent X.command")
  FILES+=("$HOME/Library/LaunchAgents/com.localagentx.desktop.plist")
else
  FILES+=("$HOME/.local/share/applications/local-agent-x.desktop")
  FILES+=("$HOME/.config/autostart/local-agent-x.desktop")
fi

# --- Confirm -----------------------------------------------------------------
PLAN=()
i=0
for d in ${DIRS+"${DIRS[@]}"}; do
  [ -e "$d" ] && PLAN+=("  ${LABELS[$i]}: $d")
  i=$((i + 1))
done
for f in ${FILES+"${FILES[@]}"}; do [ -e "$f" ] && PLAN+=("  file: $f"); done

if [ ${#PLAN[@]} -eq 0 ]; then
  echo "No Local Agent X installation was found - nothing to remove."
  exit 0
fi

echo "Local Agent X - the following will be removed:"
printf '%s\n' "${PLAN[@]}"
if [ "$DELETE_DATA" = "1" ]; then
  echo "  data (PERMANENT): $LAX_DIR"
else
  echo "  (your data in $LAX_DIR will be KEPT - pass --delete-data to remove it)"
fi

if [ "$ASSUME_YES" != "1" ] && [ "$DRY_RUN" != "1" ]; then
  printf 'Continue? [y/N] '
  read -r reply
  case "$reply" in y|Y|yes|YES) ;; *) echo "Cancelled."; exit 0 ;; esac
fi

# --- Stop running processes --------------------------------------------------
# A live Electron shell or tsx server holds handles inside the install dirs.
if [ "$DRY_RUN" != "1" ]; then
  osascript -e 'tell application "Local Agent X" to quit' >/dev/null 2>&1 || true
  pkill -f "Local Agent X.app" >/dev/null 2>&1 || true
  for d in ${DIRS+"${DIRS[@]}"}; do
    [ -n "$d" ] && pkill -f "$d" >/dev/null 2>&1 || true
  done
  sleep 2
fi

# --- Remove ------------------------------------------------------------------
i=0
for d in ${DIRS+"${DIRS[@]}"}; do
  remove_path "$d" "${LABELS[$i]}"
  i=$((i + 1))
done

for f in ${FILES+"${FILES[@]}"}; do
  [ -e "$f" ] || continue
  if [ "$DRY_RUN" = "1" ]; then REMOVED+=("[dry-run] file -> $f")
  else rm -f "$f" && REMOVED+=("file -> $f"); fi
done

if [ "$DELETE_DATA" = "1" ]; then
  remove_path "$LAX_DIR" "data directory"
elif [ -f "$LAX_DIR/config.json" ] && [ "$DRY_RUN" != "1" ]; then
  # Drop only the stale pointer so a reinstall cannot resurrect a dead
  # projectRoot, while every chat, memory and key is preserved.
  tmp="$LAX_DIR/config.json.uninstall-tmp"
  if sed 's/"projectRoot"[[:space:]]*:[[:space:]]*"[^"]*"[[:space:]]*,\{0,1\}//' "$LAX_DIR/config.json" > "$tmp" 2>/dev/null; then
    mv "$tmp" "$LAX_DIR/config.json"
    REMOVED+=("cleared stale projectRoot from ~/.lax/config.json")
  else
    rm -f "$tmp"
  fi
fi

# --- Report ------------------------------------------------------------------
echo
echo "Local Agent X has been removed."
for r in ${REMOVED+"${REMOVED[@]}"}; do echo "  removed: $r"; done
if [ ${#SKIPPED[@]} -gt 0 ]; then
  echo
  echo "Left alone:"
  for s in "${SKIPPED[@]}"; do echo "  $s"; done
fi
if [ "$DELETE_DATA" = "1" ]; then echo; echo "Your data was deleted."
else echo; echo "Your data was kept in $LAX_DIR for a future reinstall."; fi
echo "(Ollama and any downloaded models were left installed.)"
