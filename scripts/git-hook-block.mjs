/**
 * Shared installer for guarded git-hook blocks.
 *
 * Three scripts used to each re-implement "find .git/hooks, append my block,
 * don't clobber a hook someone else wrote" — and one of them (install-hooks.sh)
 * got it wrong by overwriting pre-commit wholesale, silently removing the other
 * blocks. Hooks are the one place where a second implementation destroys the
 * first, so there is exactly one implementation here.
 *
 * Each block is delimited by an id so re-running updates it in place, and
 * blocks from different features coexist in the same hook file.
 */
import { readFileSync, writeFileSync, existsSync, chmodSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

export const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

/** Absolute .git/hooks for this checkout, or null outside a git repo (tarball installs). */
export function resolveHooksDir() {
  let gitDir;
  try {
    gitDir = execFileSync("git", ["rev-parse", "--git-dir"], { cwd: REPO_ROOT, encoding: "utf-8" }).trim();
  } catch {
    return null;
  }
  // A worktree's `git rev-parse --git-dir` is relative to the worktree root.
  if (!gitDir.startsWith("/") && !/^[A-Za-z]:/.test(gitDir)) gitDir = join(REPO_ROOT, gitDir);
  return join(gitDir, "hooks");
}

/** POSIX path to a repo script, safe to embed in the `sh` a hook runs. */
export function hookScriptPath(relative) {
  return `${REPO_ROOT.split("\\").join("/")}/${relative}`;
}

/**
 * Install (or update) one guarded block in a hook. Returns what happened so the
 * caller can log it; returns "skipped" outside a git repo rather than throwing,
 * because postinstall also runs for tarball installs that have no .git.
 */
export function installHookBlock({ hook, id, body, hooksDir = resolveHooksDir() }) {
  if (!hooksDir) return { action: "skipped", reason: "not a git checkout" };
  if (!existsSync(hooksDir)) mkdirSync(hooksDir, { recursive: true });

  const hookPath = join(hooksDir, hook);
  const existing = existsSync(hookPath) ? readFileSync(hookPath, "utf-8") : "";
  const { content, action } = mergeHookBlock(existing, id, body);

  writeFileSync(hookPath, content, "utf-8");
  try { chmodSync(hookPath, 0o755); } catch { /* Windows: git runs hooks via sh regardless */ }
  return { action, hookPath };
}

/**
 * Merge one guarded block into an existing hook's text. Pure, so the merge
 * rules that keep unrelated blocks alive are testable without touching a repo.
 */
export function mergeHookBlock(existing, id, body) {
  const start = `# >>> ${id} >>>`;
  const end = `# <<< ${id} <<<`;
  const block = `${start}\n${body.trim()}\n${end}\n`;

  if (existing.includes(start)) {
    return { content: existing.replace(blockPattern(start, end), block), action: "updated" };
  }
  if (existing.trim().length > 0) {
    return { content: `${existing.endsWith("\n") ? existing : `${existing}\n`}\n${block}`, action: "appended" };
  }
  return { content: `#!/bin/sh\n${block}`, action: "created" };
}

// Delimiters contain regex metacharacters (`>`, `<` are safe but ids may not
// be), so escape before building the replace pattern.
function blockPattern(start, end) {
  const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`${esc(start)}[\\s\\S]*?${esc(end)}\\n?`);
}
