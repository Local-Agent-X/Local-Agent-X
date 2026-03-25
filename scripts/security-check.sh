#!/bin/bash
# Security check script — run before releases or in CI
# Usage: ./scripts/security-check.sh

set -e
echo "=== Open Agent X Security Check ==="

# 1. npm audit
echo ""
echo "[1/4] Running npm audit..."
npm audit --production 2>&1 || echo "⚠ npm audit found issues"

# 2. Check for secrets in codebase
echo ""
echo "[2/4] Scanning for hardcoded secrets..."
PATTERNS='(password|secret|api_key|apikey|token|private_key)\s*[=:]\s*["\x27][a-zA-Z0-9]{16,}'
if grep -rniP "$PATTERNS" src/ public/ --include="*.ts" --include="*.js" --include="*.json" 2>/dev/null | grep -v "test\|example\|placeholder\|schema\|type\|interface\|description"; then
  echo "⚠ Potential hardcoded secrets found above"
else
  echo "✓ No hardcoded secrets detected"
fi

# 3. Check lockfile exists
echo ""
echo "[3/4] Checking package-lock.json..."
if [ -f "package-lock.json" ]; then
  echo "✓ Lockfile present"
else
  echo "✖ No lockfile found — run npm install"
fi

# 4. Check critical security files exist
echo ""
echo "[4/4] Checking security files..."
REQUIRED_FILES="src/security.ts src/sanitize.ts src/threat-engine.ts src/keychain.ts SECURITY.md THREAT-MODEL.md"
ALL_OK=true
for f in $REQUIRED_FILES; do
  if [ -f "$f" ]; then
    echo "  ✓ $f"
  else
    echo "  ✖ MISSING: $f"
    ALL_OK=false
  fi
done

echo ""
if [ "$ALL_OK" = true ]; then
  echo "=== All checks passed ==="
else
  echo "=== Some checks failed ==="
  exit 1
fi
