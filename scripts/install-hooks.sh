#!/usr/bin/env bash
# install-hooks.sh — wire scripts/precommit-audit.sh into .git/hooks/.
#
# Run once after cloning the repo:
#   bash scripts/install-hooks.sh
#
# Idempotent — safe to re-run. Doesn't clobber an existing pre-commit
# unless --force is passed (it WILL refuse otherwise so a custom hook
# you wrote isn't silently replaced).

set -euo pipefail

force=0
[[ "${1:-}" == "--force" ]] && force=1

repo_root=$(git rev-parse --show-toplevel)
hooks_dir="$repo_root/.git/hooks"
target="$hooks_dir/pre-commit"

mkdir -p "$hooks_dir"

if [[ -f "$target" ]] && [[ $force -eq 0 ]]; then
  if ! grep -q "scripts/precommit-audit.sh" "$target" 2>/dev/null; then
    echo "ERROR: $target already exists and isn't ours."
    echo "       Inspect it; if you don't need it, re-run with --force."
    exit 1
  fi
fi

cat > "$target" <<'HOOK'
#!/usr/bin/env bash
# Auto-installed by scripts/install-hooks.sh — runs the local audit before
# every commit. Bypass with `git commit --no-verify` if you really must.
exec bash "$(git rev-parse --show-toplevel)/scripts/precommit-audit.sh"
HOOK

chmod +x "$target"
chmod +x "$repo_root/scripts/precommit-audit.sh"

echo "installed pre-commit hook -> $target"
echo "test it with: git commit --dry-run  (or just try a commit)"
