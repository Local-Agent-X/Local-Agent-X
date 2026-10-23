/**
 * One line of git state for a session working in a repository (a code
 * session's project folder, session/code-work-root.ts): the branch, how far it
 * is from its upstream, and what has changed. It rides the per-turn digest
 * (situational-awareness.ts), the trailing row, because it changes after
 * nearly every command; at the head of the prompt it would end the prompt
 * cache's reuse on every turn.
 *
 * Run through the publish review's hardened git (publish-review/git-exec.ts:
 * no hooks, no fsmonitor, no external drivers, a timeout), since the folder
 * can be a repository cloned from anywhere. Only for a folder with its own
 * `.git`, so a plain folder never spawns git.
 */
import { existsSync } from "node:fs";
import { join } from "node:path";
import { runGit } from "../../publish-review/git-exec.js";

const GIT_STATUS_TIMEOUT_MS = 3_000;
const FILES_SHOWN = 6;

export async function workRootGitLine(root: string | undefined): Promise<string | null> {
  if (!root || !existsSync(join(root, ".git"))) return null;
  const r = await runGit(root, ["status", "--porcelain=v1", "--branch"], { timeoutMs: GIT_STATUS_TIMEOUT_MS, keepBytes: 16_000 });
  if (r.code !== 0) return null;
  return formatGitStatus(r.stdout);
}

/** Pure: `git status --porcelain=v1 --branch` output as one line. */
export function formatGitStatus(porcelain: string): string {
  const lines = porcelain.split("\n").map((l) => l.replace(/\r$/, "")).filter(Boolean);
  const head = lines[0]?.startsWith("## ") ? lines.shift()!.slice(3) : "";
  const branch = head.split("...")[0].replace(/^No commits yet on /, "") || "(detached)";
  const drift = /\[([^\]]+)\]/.exec(head)?.[1];
  const where = `Git: on ${branch}${drift ? ` (${drift})` : ""}`;
  if (lines.length === 0) return `${where}, no changes.`;
  const shown = lines.slice(0, FILES_SHOWN).map((l) => `${l.slice(0, 2).trim()} ${l.slice(3)}`).join(", ");
  const more = lines.length > FILES_SHOWN ? ` (+${lines.length - FILES_SHOWN} more)` : "";
  return `${where}, ${lines.length} changed: ${shown}${more}`;
}
