#!/usr/bin/env node
/**
 * Installs the self_edit push guard into .git/hooks/pre-push.
 *
 * Same guarded-block pattern as install-eval-hook.mjs: idempotent, appends
 * to an existing hook rather than clobbering, re-running updates the block
 * in place. Runs from postinstall, so every git checkout gets the guard
 * without a manual step; exits 0 silently for non-git (tarball) installs.
 */
import { readFileSync, writeFileSync, existsSync, chmodSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { execSync } from "node:child_process";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

let gitDir;
try {
  gitDir = execSync("git rev-parse --git-dir", { cwd: REPO_ROOT, encoding: "utf-8" }).trim();
} catch {
  process.exit(0); // tarball install — nothing to guard
}
if (!gitDir.startsWith("/") && !/^[A-Za-z]:/.test(gitDir)) {
  gitDir = join(REPO_ROOT, gitDir);
}
const hooksDir = join(gitDir, "hooks");
if (!existsSync(hooksDir)) mkdirSync(hooksDir, { recursive: true });
const hookPath = join(hooksDir, "pre-push");

const BLOCK_START = "# >>> lax-selfedit-guard >>>";
const BLOCK_END = "# <<< lax-selfedit-guard <<<";
const BLOCK = `${BLOCK_START}
# Blocks pushes containing machine-generated "Agent selfedit-*" commits.
# Bypass: SKIP_SELFEDIT_GUARD=1 git push
node "${REPO_ROOT.replace(/\\/g, "/")}/scripts/selfedit-push-guard.mjs" <&0 || exit $?
${BLOCK_END}
`;

let content = existsSync(hookPath) ? readFileSync(hookPath, "utf-8") : "#!/bin/sh\n";
if (content.includes(BLOCK_START)) {
  content = content.replace(
    new RegExp(`${BLOCK_START}[\\s\\S]*?${BLOCK_END}\\n?`),
    BLOCK,
  );
} else {
  if (!content.endsWith("\n")) content += "\n";
  content += BLOCK;
}
writeFileSync(hookPath, content, "utf-8");
try { chmodSync(hookPath, 0o755); } catch { /* Windows: git runs hooks via sh regardless */ }
console.log(`[push-guard] self_edit guard installed at ${hookPath}`);
