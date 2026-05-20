#!/usr/bin/env node
/**
 * Installs the eval-gate pre-commit hook into .git/hooks/pre-commit.
 *
 * One-time setup per checkout — git hooks aren't checked into the repo by
 * default, so each user runs `npm run eval:install-hook` once to opt in.
 * Idempotent: if a hook already exists, the script appends a guarded block
 * rather than clobbering. Re-running updates the block in place.
 */
import { readFileSync, writeFileSync, existsSync, chmodSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { execSync } from "node:child_process";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

// Resolve .git/hooks/ — git worktrees redirect via .git file, plain repos have .git/ dir
let gitDir;
try {
  gitDir = execSync("git rev-parse --git-dir", { cwd: REPO_ROOT, encoding: "utf-8" }).trim();
} catch (e) {
  console.error(`Not in a git repo: ${e.message}`);
  process.exit(1);
}
if (!gitDir.startsWith("/") && !/^[A-Za-z]:/.test(gitDir)) {
  gitDir = join(REPO_ROOT, gitDir);
}
const hooksDir = join(gitDir, "hooks");
if (!existsSync(hooksDir)) mkdirSync(hooksDir, { recursive: true });
const hookPath = join(hooksDir, "pre-commit");

const BLOCK_START = "# >>> lax-eval-gate >>>";
const BLOCK_END = "# <<< lax-eval-gate <<<";
const BLOCK = `${BLOCK_START}
# Runs the tool-discovery eval when prompt or tool-routing files are staged.
# Bypass: SKIP_EVAL_GATE=1 git commit ...
node "${REPO_ROOT.replace(/\\/g, "/")}/scripts/eval-gate.mjs" || exit $?
${BLOCK_END}
`;

let existing = "";
if (existsSync(hookPath)) {
  existing = readFileSync(hookPath, "utf-8");
}

let next;
if (existing.includes(BLOCK_START)) {
  // Update the guarded block in place
  next = existing.replace(
    new RegExp(`${BLOCK_START}[\\s\\S]*?${BLOCK_END}\\n?`),
    BLOCK,
  );
  console.log(`[eval-gate] Updated existing block in ${hookPath}`);
} else if (existing.trim().length > 0) {
  // Append to existing hook
  next = (existing.endsWith("\n") ? existing : existing + "\n") + "\n" + BLOCK;
  console.log(`[eval-gate] Appended block to existing ${hookPath}`);
} else {
  // Fresh hook
  next = `#!/bin/sh\n${BLOCK}`;
  console.log(`[eval-gate] Created ${hookPath}`);
}

writeFileSync(hookPath, next, { encoding: "utf-8" });
try { chmodSync(hookPath, 0o755); } catch { /* Windows ignores chmod */ }

console.log(`[eval-gate] Hook installed. The gate runs automatically when you commit changes to:`);
console.log(`  - config/system-prompt.md`);
console.log(`  - src/agent-request/tool-filter.ts`);
console.log(`  - src/agent-request/audience-tagger.ts`);
console.log(`  - eval/tool-discovery/cases.json`);
console.log(`Threshold: see eval/tool-discovery/threshold.json (minPass).`);
console.log(`Bypass: SKIP_EVAL_GATE=1 git commit ...`);
