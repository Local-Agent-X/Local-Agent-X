/**
 * self_edit rollback record — the operator's escape hatch after a self_edit merge.
 *
 * Why: self_edit's gates run on the worktree branch, then the worktree merges
 * into main. The merge can combine the worktree with main commits no gate ever
 * saw, and the post-merge re-gate (in self-edit-sandbox.ts) only catches a
 * broken BUILD. If the merged code boots but misbehaves at runtime, the operator
 * needs a one-command revert. We persist the pre/post SHA of the last self_edit
 * merge so revertLastMerge() can hard-reset the base branch, and surface a
 * one-time boot notice so the operator knows the hatch exists.
 */

import { writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { getLaxDir } from "./lax-data-dir.js";
import { revertBranchTo } from "./agency/worktree.js";

import { createLogger } from "./logger.js";
const logger = createLogger("self-edit.rollback");

export interface MergeRecord {
  preSha: string;
  postSha: string;
  baseBranch: string;
  repoRoot: string;
  files: number;
  ts: string;
  surfaced: boolean;
}

/** Resolved at call time so LAX_DATA_DIR relocation (tests, CI) is honored. */
function recordPath(): string {
  return join(getLaxDir(), "last-self-edit-merge.json");
}

/** Persist the last self_edit merge (pre/post SHA) for the revert hatch. */
export function recordMerge(rec: Omit<MergeRecord, "surfaced">): void {
  try {
    const full: MergeRecord = { ...rec, surfaced: false };
    writeFileSync(recordPath(), JSON.stringify(full, null, 2), { mode: 0o600 });
  } catch (e) {
    logger.warn(`[self-edit.rollback] Failed to record merge: ${(e as Error).message}`);
  }
}

/** Read the last self_edit merge record, or null if missing/corrupt. */
export function readLastMerge(): MergeRecord | null {
  try {
    return JSON.parse(readFileSync(recordPath(), "utf-8")) as MergeRecord;
  } catch {
    return null;
  }
}

/** Manual revert: hard-reset the base branch back to the pre-merge SHA. */
export function revertLastMerge(): { ok: boolean; detail: string } {
  const rec = readLastMerge();
  if (!rec) return { ok: false, detail: "no self_edit merge recorded" };
  return revertBranchTo(rec.repoRoot, rec.baseBranch, rec.preSha);
}

/**
 * One-time boot notice. If a self_edit merge was recorded and not yet surfaced,
 * warn the operator (post SHA, when, file count) and how to revert, then mark it
 * surfaced so the banner fires exactly once. No-op + best-effort otherwise.
 */
export function surfaceUnacknowledgedMerge(): void {
  try {
    const rec = readLastMerge();
    if (!rec || rec.surfaced) return;
    logger.warn(
      [
        `─────────────────────────────────────────────`,
        `self_edit merged into ${rec.baseBranch} (${rec.postSha.slice(0, 8)})`,
        `  when: ${rec.ts}   files: ${rec.files}`,
        `  If the app is misbehaving since this merge, revert it:`,
        `  call revertLastMerge() (self-edit-rollback) to reset ${rec.baseBranch} to the pre-merge state.`,
        `─────────────────────────────────────────────`,
      ].join("\n"),
    );
    rec.surfaced = true;
    writeFileSync(recordPath(), JSON.stringify(rec, null, 2), { mode: 0o600 });
  } catch (e) {
    logger.warn(`[self-edit.rollback] Failed to surface merge notice: ${(e as Error).message}`);
  }
}
