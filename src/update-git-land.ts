/**
 * Git route, second half: land a prepared candidate (update-git-prepare.ts) on
 * the live checkout. The caller holds the machine-wide mutation lock.
 *
 * The candidate was built in its worktree, so landing takes that build output
 * instead of building the live tree again (the second build was 40 s of a
 * 1 min 44 s update, 2026-11-15). The output is exactly the landed commit's:
 * landing refuses unless the live checkout is still on the commit the
 * candidate was prepared from, so the fast-forward lands the very tree that
 * was built, and `dist/.builtref` names it. If anything goes wrong the branch
 * is reverted as before; a dist left behind then names a commit the checkout
 * is not on, and the next launch's freshness check rebuilds it.
 */
import { existsSync, readdirSync } from "node:fs";
import { cp, rename, rm } from "node:fs/promises";
import { join } from "node:path";

import { getBranchHead, getMergeBaseInfo, mergeWorktree } from "./agency/worktree.js";
import { recordDesktopPrebuildOutcome } from "./desktop-prebuild-marker.js";
import { createLogger } from "./logger.js";
import { cancelUpdateLanding, confirmUpdateLanding, prepareUpdateLanding, restoreUpdateLanding } from "./update-git-rollback.js";
import { syncLiveDeps, updateGit } from "./update-live-deps.js";
import type { GitUpdateResult } from "./update-pipeline.js";
import type { StagedGitUpdate } from "./update-staging.js";
import { updateStep } from "./update-progress.js";

const logger = createLogger("update-pipeline");

export interface LandGitResult extends GitUpdateResult {
  /** The checkout moved since the candidate was prepared: nothing was changed. */
  stale?: boolean;
}

/** The build output directories a candidate carries, relative to the repo root. */
export function buildOutputDirs(root: string, desktopBuilt: boolean): string[] {
  const dirs = ["dist"];
  const ari = join(root, "packages", "arikernel");
  if (existsSync(ari)) {
    for (const pkg of readdirSync(ari)) if (existsSync(join(ari, pkg, "dist"))) dirs.push(join("packages", "arikernel", pkg, "dist"));
  }
  if (desktopBuilt) dirs.push(join("desktop", "dist"));
  return dirs;
}

/** Moves `from` to `to`, copying when a rename can't (another volume, a held file). */
async function moveDir(from: string, to: string): Promise<void> {
  await rm(to, { recursive: true, force: true });
  try { await rename(from, to); }
  catch {
    await cp(from, to, { recursive: true, force: true });
    await rm(from, { recursive: true, force: true }).catch(() => { /* the worktree cleanup removes it */ });
  }
}

/** Puts `<dir>.next` in place of `<dir>` in the live tree. */
async function swapIn(liveRoot: string, rel: string): Promise<void> {
  const live = join(liveRoot, rel);
  const next = `${live}.next`;
  const prev = `${live}.prev`;
  await rm(prev, { recursive: true, force: true });
  try {
    if (existsSync(live)) await rename(live, prev);
    await rename(next, live);
  } catch {
    // A file under the live dir is held open (Windows): write over it instead.
    await cp(next, live, { recursive: true, force: true });
  }
  await rm(next, { recursive: true, force: true });
  rm(prev, { recursive: true, force: true }).catch(() => { /* removed on the next landing */ });
}

export async function landGitUpdate(staged: StagedGitUpdate, repoRoot: string): Promise<LandGitResult> {
  const ids = { fromCommit: staged.base.slice(0, 7), toCommit: staged.target.slice(0, 7), gates: staged.gates };
  updateStep("land");
  const head = await updateGit("git rev-parse HEAD", repoRoot);
  if (head !== staged.base) {
    return { ok: false, stale: true, ...ids, detail: "This install changed since the update was prepared; it is prepared again." };
  }
  const outputs = buildOutputDirs(staged.worktreePath, staged.desktopBuilt);
  // Out of the worktree before the merge removes it: the merge cleans the worktree up.
  for (const rel of outputs) await moveDir(join(staged.worktreePath, rel), `${join(repoRoot, rel)}.next`);
  const dropNext = () => Promise.all(outputs.map((rel) => rm(`${join(repoRoot, rel)}.next`, { recursive: true, force: true })));

  const mergeInfo = await getMergeBaseInfo(staged.worktree);
  if (!mergeInfo) { await dropNext(); return { ok: false, stale: true, ...ids, detail: "The prepared update's worktree is gone; it is prepared again." }; }
  prepareUpdateLanding(staged.worktreePath, mergeInfo);
  const merge = mergeWorktree(staged.worktree);
  if (!merge.merged) {
    cancelUpdateLanding(mergeInfo);
    await dropNext();
    return { ok: false, ...ids, detail: `Gates passed but landing failed: ${merge.error || "unknown"}` };
  }
  try {
    // The gated install ran against the worktree's isolated deps; the live
    // tree's node_modules still has the old set. A Windows file lock defers to
    // the next launch's reconcile; only a real dependency error reverts.
    if (staged.depsChanged) await syncLiveDeps(repoRoot);
    for (const rel of outputs) await swapIn(repoRoot, rel);
  } catch (e) {
    restoreUpdateLanding(mergeInfo);
    if (staged.depsChanged) await syncLiveDeps(repoRoot).catch(() => { /* old lockfile restored, next boot retries */ });
    await dropNext();
    return { ok: false, ...ids, detail: `Update reverted — landing on the live tree failed: ${(e as Error).message.slice(0, 600)}` };
  }
  const postSha = getBranchHead(mergeInfo.repoRoot, mergeInfo.baseBranch);
  confirmUpdateLanding(mergeInfo, postSha, merge.files);
  if (staged.desktopBuilt) recordDesktopPrebuildOutcome(true, "desktop/dist built with the prepared update");
  logger.info(`[update] applied ${ids.fromCommit} → ${postSha.slice(0, 7)} (${merge.files} files, prepared build)`);
  return { ok: true, ...ids, toCommit: postSha.slice(0, 7), detail: `Updated (${merge.files} files). Restart to finish.` };
}
