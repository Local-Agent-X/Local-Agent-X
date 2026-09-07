#!/usr/bin/env bash
# install-hooks.sh — wire scripts/precommit-audit.sh into .git/hooks/pre-commit.
#
# Run once after cloning the repo:
#   bash scripts/install-hooks.sh
#
# Idempotent. Installs a GUARDED BLOCK rather than writing the whole hook: this
# script used to `cat >` over pre-commit, which silently deleted the
# generated-docs block postinstall puts there — and a missing generated-docs
# block is how a stale docs/codebase-map.md reaches main and blocks updates for
# every install. Block installation is shared with the other hook installers in
# scripts/git-hook-block.mjs.

set -euo pipefail

repo_root=$(git rev-parse --show-toplevel)
chmod +x "$repo_root/scripts/precommit-audit.sh" 2>/dev/null || true
exec node "$repo_root/scripts/install-audit-hook.mjs"
