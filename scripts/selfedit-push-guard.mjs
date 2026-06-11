#!/usr/bin/env node
/**
 * Pre-push guard: blocks pushes that contain machine-generated self_edit
 * commits ("Agent selfedit-...: automated changes").
 *
 * Those commits are how a developer_mode self_edit lands locally — they are
 * never legitimate to publish verbatim. Before pushing, either reword the
 * commit into a real message (it's product work) or drop it (it was a
 * personal/local change). Bypass for emergencies: SKIP_SELFEDIT_GUARD=1.
 *
 * Reads the standard pre-push stdin lines: "<local-ref> <local-sha>
 * <remote-ref> <remote-sha>".
 */
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";

if (process.env.SKIP_SELFEDIT_GUARD === "1") process.exit(0);

const ZERO_SHA = /^0+$/;
let stdin = "";
try { stdin = readFileSync(0, "utf-8"); } catch { process.exit(0); }

const offenders = [];
for (const line of stdin.split("\n").filter(Boolean)) {
  const [, localSha, , remoteSha] = line.split(" ");
  if (!localSha || ZERO_SHA.test(localSha)) continue; // deleting a remote ref
  // New remote branch: bound the walk by everything already on any remote.
  const range = ZERO_SHA.test(remoteSha || "")
    ? [localSha, "--not", "--remotes"]
    : [`${remoteSha}..${localSha}`];
  let log = "";
  try {
    log = execFileSync("git", ["log", "--format=%h %s", ...range], { encoding: "utf-8" });
  } catch { continue; }
  for (const commit of log.split("\n").filter(Boolean)) {
    if (/^\S+ Agent selfedit-/.test(commit)) offenders.push(commit);
  }
}

if (offenders.length === 0) process.exit(0);

console.error(
  `\nPush blocked: ${offenders.length} machine-generated self_edit commit(s) in this push:\n\n` +
  offenders.map((c) => `    ${c}`).join("\n") +
  `\n\nThese are raw self_edit merge commits. Before publishing:\n` +
  `  - keep the change:  git rebase -i to reword it into a real commit message\n` +
  `    (or, if it's the latest commit: git commit --amend)\n` +
  `  - drop the change:  git revert <sha>  (or rebase it out)\n` +
  `Emergency bypass: SKIP_SELFEDIT_GUARD=1 git push\n`,
);
process.exit(1);
