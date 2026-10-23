import { fileURLToPath } from "node:url";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { collectAgentsMd } from "../context/agents-md-files.js";

export const LAX_REPO_ROOT = fileURLToPath(new URL("../..", import.meta.url));

/**
 * True when this install is a git checkout (developer install). Packaged
 * installs are extracted source tarballs with no .git — there the worktree
 * sandbox can't exist, so self_edit is impossible and the Developer Mode
 * surface is hidden. `.git` may be a dir (clone) or a file (linked worktree);
 * existsSync covers both.
 */
export function isGitCheckout(): boolean {
  return existsSync(join(LAX_REPO_ROOT, ".git"));
}

/**
 * The AGENTS.md files from LAX's repo root down to scopeHint, root first, so
 * subtree rules (listed last) take precedence (context/agents-md-files.ts).
 */
export async function collectSubtreeRules(scopeHint: string): Promise<string> {
  return collectAgentsMd(LAX_REPO_ROOT, scopeHint);
}
