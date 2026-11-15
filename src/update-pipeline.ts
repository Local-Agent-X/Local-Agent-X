/**
 * Update pipeline — platform updates land through the SAME validation
 * machinery as self_edit: isolated candidate tree → deps/build/bind/smoke
 * gates → merge/swap → post-land rebuild → recordMerge (boot-crash
 * auto-revert). Before this module there were three independent paths that
 * mutated the install (self_edit merge, `git pull --ff-only`, OTA tarball
 * copy) with three different safety levels; the raw pull hard-failed forever
 * once local commits existed, and the tarball copy silently overwrote them.
 *
 * Two sources, one validation contract:
 *   - applyGitUpdate:          git checkouts. Fetch → merge origin/main into a
 *                              worktree → gates → fast-forward main.
 *   - validateExtractedUpdate: tarball installs (no git). Gates run directly
 *                              on the extracted tree before OTAManager copies
 *                              it over the install.
 *
 * Local commits (developer_mode self_edits) are merged with the update inside
 * the worktree; a conflict HOLDS the update with instructions instead of
 * bricking the update path. Without developer_mode, local commits shouldn't
 * exist — if they do, the update is held and says why.
 */


import { OTAManager } from "./ota-update.js";
import type { GateResult } from "./self-edit/sandbox-gates.js";
import { acquireGlobalSelfEditLock, releaseGlobalSelfEditLock } from "./self-edit/global-lock.js";
import { getLaxDir } from "./lax-data-dir.js";
import { recordUpdateFailure, recordUpdateSuccess, repairStuckUpdateState, markRepairAttempted, REPAIR_THRESHOLD } from "./update-recovery.js";
import { createLogger } from "./logger.js";
import { discardRollingStaged, landRollingUpdate, prepareRollingUpdate } from "./update-rolling.js";
import { discardGitStaged, prepareGitUpdate } from "./update-git-prepare.js";
import { landGitUpdate } from "./update-git-land.js";

import { readyUpdate, takeReady, type StagedGitUpdate, type StagedRollingUpdate } from "./update-staging.js";
import { beginUpdateProgress, endUpdateProgress, updateProgressActive } from "./update-progress.js";
import { discardStaged } from "./update-background.js";

export { validateExtractedUpdate } from "./update-extracted-validation.js";
export type { ExtractValidation } from "./update-extracted-validation.js";
export { isDeferrableFileLock, syncLiveDeps } from "./update-live-deps.js";

const logger = createLogger("update-pipeline");
const UPDATE_BUSY =
  "Another update or self_edit is currently running on this machine. " +
  "Updates are applied one at a time — wait for it to finish, then try again.";

export interface UpdateGates { deps: GateResult; build: GateResult; bind: GateResult; smoke: GateResult }

export interface GitUpdateResult {
  ok: boolean;
  /** Deliberately not applied (divergence without developer_mode, merge
   *  conflict, concurrent self_edit) — distinct from a gate failure. */
  held?: boolean;
  fromCommit: string;
  toCommit: string;
  detail: string;
  gates?: UpdateGates;
}

export async function applyGitUpdate(repoRoot: string, authToken: string): Promise<GitUpdateResult> {
  // Same machine-wide lock as the self_edit sandbox: landing mutates main and
  // the shared node_modules, so it must never run beside another mutation.
  const lock = await acquireGlobalSelfEditLock({ task: "platform update" });
  if (!lock.acquired) {
    logger.info(`[update] refused — lock held by ${JSON.stringify(lock.holder ?? "unknown")}`);
    return { ok: false, held: true, fromCommit: "", toCommit: "", detail: UPDATE_BUSY };
  }
  try {
    beginUpdateProgress("installing");
    return await prepareAndLandGit(repoRoot, authToken, `update:${lock.nonce}`);
  } finally {
    endUpdateProgress();
    await releaseGlobalSelfEditLock(lock.nonce);
  }
}

/** The full git route under a held lock: prepare a candidate, then land it. */
async function prepareAndLandGit(repoRoot: string, authToken: string, owner: string): Promise<GitUpdateResult> {
  let staged: StagedGitUpdate | undefined;
  try {
    const prepared = await prepareGitUpdate(repoRoot, authToken, owner);
    staged = prepared.staged;
    if (!staged) return withoutStaged(prepared);
    const landed = await landGitUpdate(staged, repoRoot);
    if (!landed.ok) await discardGitStaged(staged, repoRoot);
    staged = undefined;
    return { ok: landed.ok, held: landed.held, fromCommit: landed.fromCommit, toCommit: landed.toCommit, detail: landed.detail, gates: landed.gates };
  } catch (e) {
    if (staged) await discardGitStaged(staged, repoRoot).catch(() => { /* swept at next boot */ });
    return { ok: false, fromCommit: "", toCommit: "", detail: `Update pipeline crashed: ${(e as Error).message}` };
  }
}

function withoutStaged(r: GitUpdateResult & { staged?: unknown }): GitUpdateResult {
  const { staged: _staged, ...rest } = r;
  return rest;
}

/** Tarball updates share the self-edit lock and the canonical validation gates. */
export async function applyRollingUpdate(installDir: string, authToken: string): Promise<GitUpdateResult> {
  const lock = await acquireGlobalSelfEditLock({ task: "platform update (rolling)" });
  if (!lock.acquired) {
    logger.info(`[update] rolling refused — lock held by ${JSON.stringify(lock.holder ?? "unknown")}`);
    return { ok: false, held: true, fromCommit: "", toCommit: "", detail: UPDATE_BUSY };
  }
  const ota = new OTAManager();
  let staged: StagedRollingUpdate | undefined;
  beginUpdateProgress("installing");
  try {
    await ota.recoverPendingUpdate(installDir);
    const prepared = await prepareRollingUpdate(installDir, authToken, ota);
    staged = prepared.staged;
    if (!staged) {
      if (prepared.ok) recordUpdateSuccess(getLaxDir());
      return withoutStaged(prepared);
    }
    const landed = await landRollingUpdate(staged, installDir, ota);
    staged = undefined;
    recordUpdateSuccess(getLaxDir());
    return { ok: landed.ok, fromCommit: landed.fromCommit, toCommit: landed.toCommit, detail: landed.detail, gates: landed.gates };
  } catch (e) {
    if (staged) await discardRollingStaged(staged, ota).catch(() => { /* removed by the next prepare */ });
    // Local-only self-repair: notice a failing-update streak and, past the
    // threshold, clear the transient state a stuck update leaves behind (rollback
    // journal + half-downloaded payload) so the NEXT attempt starts clean. No
    // auto-retry — a genuinely broken release still can't spin.
    const laxDir = getLaxDir();
    let detail = (e as Error).message;
    const health = recordUpdateFailure(laxDir, detail);
    if (health.consecutiveFailures >= REPAIR_THRESHOLD && !health.repairAttempted) {
      const cleared = repairStuckUpdateState(laxDir);
      markRepairAttempted(laxDir);
      if (cleared.length) {
        logger.warn(`[update] ${health.consecutiveFailures} consecutive update failures — cleared stale state (${cleared.join(", ")}); retry should start clean`);
        detail += ` — Update has failed ${health.consecutiveFailures} times; Local Agent X cleared stale update state (${cleared.join(", ")}). Try updating again.`;
      }
    }
    return { ok: false, fromCommit: "", toCommit: "", detail };
  } finally {
    endUpdateProgress();
    await releaseGlobalSelfEditLock(lock.nonce);
  }
}

/**
 * Lands the update prepared in the background (update-background.ts), if one
 * is ready: seconds, no build. Null when none is ready, or when the one that
 * was no longer fits this install (it is discarded); the caller then runs the
 * full path.
 */
export async function landPreparedUpdate(installDir: string): Promise<(GitUpdateResult & { rolling?: boolean }) | null> {
  if (!readyUpdate()) return null;
  const lock = await acquireGlobalSelfEditLock({ task: "platform update" });
  if (!lock.acquired) return { ok: false, held: true, fromCommit: "", toCommit: "", detail: UPDATE_BUSY };
  const staged = takeReady();
  try {
    if (!staged) return null;
    if (!updateProgressActive()) beginUpdateProgress("installing");
    const landed = staged.route === "git" ? await landGitUpdate(staged, installDir) : await landRollingUpdate(staged, installDir);
    if (!landed.ok) await discardStaged(staged).catch(() => { /* swept at next boot */ });
    if (landed.stale) return null;
    if (landed.ok && staged.route === "rolling") recordUpdateSuccess(getLaxDir());
    return { ok: landed.ok, held: landed.held, fromCommit: landed.fromCommit, toCommit: landed.toCommit, detail: landed.detail, gates: landed.gates, ...(staged.route === "rolling" ? { rolling: true } : {}) };
  } catch (e) {
    if (staged) await discardStaged(staged).catch(() => { /* swept at next boot */ });
    return { ok: false, fromCommit: "", toCommit: "", detail: `Installing the prepared update failed: ${(e as Error).message}` };
  } finally {
    endUpdateProgress();
    await releaseGlobalSelfEditLock(lock.nonce);
  }
}
