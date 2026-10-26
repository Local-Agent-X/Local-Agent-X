/**
 * A fingerprint of a work tree's changed set, for the loop's work check-in
 * (canonical-loop/work-check-in.ts): git's porcelain status — tracked changes
 * and every untracked file — plus each listed file's size and mtime, so
 * rewriting a file with new bytes counts as a change and re-saving the same
 * bytes does not. Null when the root is not a git repository, or git cannot
 * answer in time; the loop then falls back to its dry-checkpoint rule.
 *
 * Lives here, with the other git runners over sub-agent worktrees, because the
 * loop itself spawns nothing (canonical-loop-11-boundary-audit): the server
 * hands this function to the loop at boot.
 */
import { createHash } from "node:crypto";
import { statSync } from "node:fs";
import { join } from "node:path";
import { composeGitArgs, execGitSync } from "../git-safety.js";

export function workTreeFingerprint(root: string): string | null {
  let porcelain: string;
  try {
    porcelain = execGitSync(composeGitArgs(["-C", root, "status", "--porcelain", "--untracked-files=all"]), {
      encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"], timeout: 10_000, windowsHide: true, maxBuffer: 16 * 1024 * 1024,
    });
  } catch {
    return null;
  }
  const hash = createHash("sha1").update(porcelain);
  for (const line of porcelain.split("\n")) {
    const rel = line.slice(3).trim();
    if (!rel) continue;
    try {
      const st = statSync(join(root, rel.replace(/^"|"$/g, "")));
      hash.update(`${rel}:${st.size}:${st.mtimeMs}\n`);
    } catch { /* deleted or renamed away: the porcelain line already carries that */ }
  }
  return hash.digest("hex");
}
