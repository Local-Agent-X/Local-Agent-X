#!/usr/bin/env bash
# precommit-audit.sh — local guard against the "broke main" mistakes.
#
# Runs five checks against the staged tree:
#   1. workspace/ files staged           (defense in depth — gitignored already)
#   2. obvious secret values inserted    (sk-ant-, sk-proj-, ghp_, gho_, JWTs)
#   3. plausibly-personal file paths     (anthropic-auth.json, secrets.enc, etc.)
#   4. tracked code imports a path the git index doesn't have  ← today's bug
#   5. .env / *.key / credentials.* files staged
#
# Exits non-zero on any violation. The pre-commit hook calls this script
# (see scripts/install-hooks.sh). CI runs it too.
#
# Bypass for emergencies:  git commit --no-verify
# (Don't make a habit of it.)

set -uo pipefail

RED=$'\033[31m'; YELLOW=$'\033[33m'; GREEN=$'\033[32m'; BOLD=$'\033[1m'; RESET=$'\033[0m'

fail_count=0
warn_count=0

fail() {
  printf "%s%sFAIL%s %s\n" "$RED" "$BOLD" "$RESET" "$1" >&2
  fail_count=$((fail_count + 1))
}
warn() {
  printf "%s%sWARN%s %s\n" "$YELLOW" "$BOLD" "$RESET" "$1" >&2
  warn_count=$((warn_count + 1))
}

# Get the list of files staged for commit (Added/Copied/Modified/Renamed/Type-changed).
mapfile -t staged < <(git diff --cached --name-only --diff-filter=ACMRT)
if [[ ${#staged[@]} -eq 0 ]]; then
  exit 0
fi

# ── 1. workspace/ files (defense in depth) ─────────────────────────────────
for f in "${staged[@]}"; do
  case "$f" in
    workspace/*)
      fail "workspace/ file staged: $f  (workspace/ is personal — never commit)"
      ;;
  esac
done

# ── 2. secret values inserted ──────────────────────────────────────────────
# Look at staged DIFFS, only added (+) lines, for known secret prefixes.
# (Removing a secret is good — only flag insertions.)
secret_patterns='sk-ant-(api03|oat)-[A-Za-z0-9_-]{20,}|sk-proj-[A-Za-z0-9_-]{20,}|ghp_[A-Za-z0-9]{30,}|gho_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{50,}|xoxb-[0-9]+-[0-9]+-[A-Za-z0-9]+|AKIA[0-9A-Z]{16}|eyJ[A-Za-z0-9_-]{20,}\.eyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}'
secret_hits=$(git diff --cached -U0 -- "${staged[@]}" 2>/dev/null \
  | grep -E "^\+" \
  | grep -vE "^\+\+\+" \
  | grep -nE "$secret_patterns" || true)
if [[ -n "$secret_hits" ]]; then
  fail "secret-shaped value in staged diff:"
  printf '  %s\n' "$secret_hits" | head -5 >&2
fi

# ── 3. plausibly-personal file paths ───────────────────────────────────────
for f in "${staged[@]}"; do
  case "$f" in
    *anthropic-auth.json|*openai-codex-tokens.json|*secrets.enc|*secrets.json \
      |*conversations.json|*memory-store.json|*chat-history.json \
      |*credentials.*|*.tokens|*.pem|*.key|*.pfx|*.p12 \
      |*personal-*.md|*private-*.md)
      fail "personal-data filename: $f"
      ;;
    .env|.env.*|*/\.env|*/.env.*)
      fail ".env file staged: $f"
      ;;
  esac
done

# ── 4. import refers to a path NOT in the git index (today's actual bug) ──
# For each staged TS file, find relative imports and check they resolve to a
# tracked file. Catches "added the import line, forgot to git add the file."
mapfile -t indexed < <(git ls-files)
indexed_set=" $(printf '%s ' "${indexed[@]}") "

resolve_import() {
  # $1 = importer file path, $2 = relative import (e.g., "./asset-tools.js")
  local importer_dir base resolved
  importer_dir=$(dirname "$1")
  # Strip .js extension; we'll try .ts / .tsx / index.ts / index.tsx
  base="${2%.js}"
  base="${base%.tsx}"
  base="${base%.ts}"
  # Normalize the path (importer_dir + base)
  resolved=$(realpath -m --relative-to=. "$importer_dir/$base" 2>/dev/null || echo "")
  [[ -z "$resolved" ]] && return 1
  for ext in ".ts" ".tsx" "/index.ts" "/index.tsx" ".js" ".jsx"; do
    case "$indexed_set" in
      *" ${resolved}${ext} "*) return 0 ;;
    esac
  done
  return 1
}

for f in "${staged[@]}"; do
  case "$f" in
    *.ts|*.tsx)
      # Pull import specifiers — relative ones only ("./..." or "../...").
      mapfile -t imports < <(git diff --cached -U0 -- "$f" 2>/dev/null \
        | grep -E '^\+' \
        | grep -vE '^\+\+\+' \
        | grep -oE 'from\s+"\.+\/[^"]+"|from\s+'\''\.+\/[^'\'']+'\''|import\s*\(\s*"\.+\/[^"]+"\s*\)' \
        | grep -oE '"[^"]+"|'\''[^'\'']+'\'' ' \
        | tr -d '"'"'" )
      for imp in "${imports[@]:-}"; do
        [[ -z "$imp" ]] && continue
        if ! resolve_import "$f" "$imp"; then
          fail "$f imports '$imp' but no matching file is tracked in git"
        fi
      done
      ;;
  esac
done

# ── Summary ────────────────────────────────────────────────────────────────
if [[ $fail_count -gt 0 ]]; then
  printf "\n%s%s%d failure(s)%s — commit blocked. Fix or use --no-verify to bypass.\n" \
    "$RED" "$BOLD" "$fail_count" "$RESET" >&2
  exit 1
fi

if [[ $warn_count -gt 0 ]]; then
  printf "\n%s%d warning(s)%s — proceeding.\n" "$YELLOW" "$warn_count" "$RESET" >&2
fi

printf "%saudit clean%s (%d files)\n" "$GREEN" "$RESET" "${#staged[@]}" >&2
exit 0
