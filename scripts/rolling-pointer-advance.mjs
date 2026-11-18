// May the rolling pointer move from the commit it names to this one?
//
// The pointer (rolling-source-latest.json) names the newest CI-proven commit;
// every rolling install updates to it. It must never walk backwards: a run for
// an older push that finishes after a newer one would otherwise hand every
// client the older code. So it moves only to a descendant of what it names.
//
// A pointer naming a commit that is in no branch any more (history rewritten,
// as when a commit's author is rewritten and main is force-pushed) has nothing
// a descendant can be measured against. Holding there froze the channel: from
// 2026-10-07 to 2026-11-18 the pointer named 91cb7ff, rewritten as a94615aa1,
// every run logged "Not a valid commit name" and left it, and a fresh install
// of current main was offered the six-week-old commit as its update, which
// today's updater then rejected for lacking the build:runtime script. A
// rewritten-away commit is not ahead of anything, so the pointer moves on.
//
// Usage (rolling-source.yml): node scripts/rolling-pointer-advance.mjs <published-commit|""> <sha>
// Prints "advance" or "hold"; a GitHub warning annotation says why when not plain.

import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

/** Git questions asked of the checkout (full history: fetch-depth 0). */
export function gitHistory(cwd = process.cwd()) {
  const ok = (args) => {
    try { execFileSync("git", args, { cwd, stdio: "ignore" }); return true; } catch { return false; }
  };
  return {
    isCommit: (c) => ok(["cat-file", "-e", `${c}^{commit}`]),
    isAncestor: (a, b) => ok(["merge-base", "--is-ancestor", a, b]),
  };
}

/** @returns {{ advance: boolean, warning?: string }} */
export function pointerAdvanceVerdict(current, sha, git) {
  if (!current || current === sha) return { advance: true };
  if (!git.isCommit(current)) {
    return { advance: true, warning: `Published ${current} is in no branch of this repository (history was rewritten); moving the pointer to ${sha}.` };
  }
  if (!git.isAncestor(current, sha)) {
    return { advance: false, warning: `${sha} does not descend from published ${current}; leaving the pointer where it is.` };
  }
  return { advance: true };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [current = "", sha = ""] = process.argv.slice(2);
  if (!/^[0-9a-f]{40}$/.test(sha)) {
    console.error(`rolling-pointer-advance: expected a full 40-char sha, got ${JSON.stringify(sha)}`);
    process.exit(2);
  }
  const verdict = pointerAdvanceVerdict(current.trim(), sha, gitHistory());
  if (verdict.warning) console.error(`::warning title=Rolling pointer::${verdict.warning}`);
  process.stdout.write(verdict.advance ? "advance" : "hold");
}
