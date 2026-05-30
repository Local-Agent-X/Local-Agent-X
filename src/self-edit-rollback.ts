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
import { revertBranchTo, runRepoBuild } from "./agency/worktree.js";

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
  /** True from merge until a server boot confirms the merged code binds. A
   *  still-pending record at boot (with bootAttempts ≥ 1) means a prior boot
   *  attempt loaded the merge and never bound — i.e. it crashed on boot. */
  bootPending: boolean;
  /** Boots that have ATTEMPTED to confirm this merge. 0 = merge recorded, not
   *  yet booted into; ≥ 1 = a boot tried and (if still pending) didn't bind. */
  bootAttempts: number;
}

/** Resolved at call time so LAX_DATA_DIR relocation (tests, CI) is honored. */
function recordPath(): string {
  return join(getLaxDir(), "last-self-edit-merge.json");
}

/** Snapshot of the repo HEAD taken right before a gateless `_unsafe` self_edit
 *  writes directly to the working tree. The unsafe path runs NO gates by
 *  design (emergency rescue), so this pre-edit SHA is the only breadcrumb back
 *  to the last known-good state if the rescue makes things worse. */
export interface UnsafeEditRecord {
  preSha: string;
  repoRoot: string;
  task: string;
  ts: string;
}

function unsafeRecordPath(): string {
  return join(getLaxDir(), "last-unsafe-self-edit.json");
}

/** Persist the pre-edit SHA before a gateless `_unsafe` self_edit runs. */
export function recordUnsafeEdit(rec: UnsafeEditRecord): void {
  try {
    writeFileSync(unsafeRecordPath(), JSON.stringify(rec, null, 2), { mode: 0o600 });
  } catch (e) {
    logger.warn(`[self-edit.rollback] Failed to record unsafe edit: ${(e as Error).message}`);
  }
}

/** Read the last gateless `_unsafe` self_edit snapshot, or null if none/corrupt. */
export function readLastUnsafeEdit(): UnsafeEditRecord | null {
  try {
    return JSON.parse(readFileSync(unsafeRecordPath(), "utf-8")) as UnsafeEditRecord;
  } catch {
    return null;
  }
}

/** Persist the last self_edit merge (pre/post SHA) for the revert hatch. The
 *  merge starts boot-pending: the next server boot must confirm it binds. */
export function recordMerge(rec: Omit<MergeRecord, "surfaced" | "bootPending" | "bootAttempts">): void {
  try {
    const full: MergeRecord = { ...rec, surfaced: false, bootPending: true, bootAttempts: 0 };
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
 * Called once the server confirms it bound (from the listen callback). Clears
 * the boot-pending flag on the last merge so the next boot's crashed-merge guard
 * knows the merged code booted. Best-effort; no-op when nothing is pending.
 */
export function confirmMergeBoot(): void {
  try {
    const rec = readLastMerge();
    if (!rec || !rec.bootPending) return;
    rec.bootPending = false;
    writeFileSync(recordPath(), JSON.stringify(rec, null, 2), { mode: 0o600 });
    logger.info(`[self-edit.rollback] merged code booted successfully (${rec.postSha.slice(0, 8)}) — boot-pending cleared`);
  } catch (e) {
    logger.warn(`[self-edit.rollback] Failed to confirm merge boot: ${(e as Error).message}`);
  }
}

/**
 * Boot-time crashed-merge guard — the runtime half of the merge safety net.
 *
 * The post-merge re-gate only proves the merged tree BUILDS, not that it BOOTS.
 * A merge that compiles but crashes on startup would otherwise brick every
 * restart until a human ran revertLastMerge(). This closes that gap:
 *
 *   - A merge record starts bootPending with bootAttempts=0.
 *   - The FIRST boot after a merge legitimately starts pending (it binds later,
 *     in the listen callback, which calls confirmMergeBoot). So we don't revert
 *     on the first attempt — we just record the attempt and let it try.
 *   - If a LATER boot still finds it pending with bootAttempts ≥ 1, the prior
 *     attempt loaded the merge and never bound → it crashed on boot → we revert
 *     the base branch to the pre-merge SHA and rebuild (so both `tsx src` and
 *     `node dist` runs pick up the good code on the next boot), then clear the
 *     pending flag.
 *
 * The merge commit (postSha) is logged so the operator can redo it if the revert
 * was unwanted. Entirely best-effort: it must never throw out of the boot path.
 * Known limit: a merge that throws at module-IMPORT time (before this runs) can
 * still take the process down before the guard executes — the re-gate build is
 * the first line of defense for that; this handles bind/startup-time crashes.
 */
export function revertPendingMergeIfCrashed(): { reverted: boolean; detail: string } | null {
  try {
    const rec = readLastMerge();
    if (!rec || !rec.bootPending) return null;

    if ((rec.bootAttempts ?? 0) >= 1) {
      logger.warn(
        [
          `─────────────────────────────────────────────`,
          `self_edit merge ${rec.postSha.slice(0, 8)} did NOT bind on the last boot — AUTO-REVERTING`,
          `  merged: ${rec.ts}   files: ${rec.files}   base: ${rec.baseBranch}`,
          `  to redo it later: git reset --hard ${rec.postSha.slice(0, 12)}`,
          `─────────────────────────────────────────────`,
        ].join("\n"),
      );
      const revert = revertBranchTo(rec.repoRoot, rec.baseBranch, rec.preSha);
      // Rebuild so dist matches the reverted source — `npm start` runs from dist,
      // so a source-only revert would leave it running the bad build.
      let detail = revert.ok ? `reverted ${rec.baseBranch} to ${rec.preSha.slice(0, 8)}` : `revert FAILED: ${revert.detail}`;
      if (revert.ok) {
        const rebuilt = runRepoBuild(rec.repoRoot, 5 * 60_000);
        detail += rebuilt.ok ? "; rebuilt" : `; rebuild FAILED: ${rebuilt.detail.slice(0, 200)}`;
      }
      rec.bootPending = false;
      rec.surfaced = true;
      writeFileSync(recordPath(), JSON.stringify(rec, null, 2), { mode: 0o600 });
      return { reverted: revert.ok, detail };
    }

    // First boot into this merge — record the attempt and let it try to bind.
    rec.bootAttempts = (rec.bootAttempts ?? 0) + 1;
    writeFileSync(recordPath(), JSON.stringify(rec, null, 2), { mode: 0o600 });
    return null;
  } catch (e) {
    logger.warn(`[self-edit.rollback] crashed-merge guard failed: ${(e as Error).message}`);
    return null;
  }
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
