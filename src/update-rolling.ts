/**
 * Download route (installs without git), in the same two halves as the git
 * route: prepare downloads the CI-published, checksum-verified source and
 * validates it in its own folder (OTAManager.stageExtract + the update gates),
 * touching nothing live; land copies it over the install under the rollback
 * transaction (OTAManager.landExtract), installs dependencies that changed,
 * and records the new commit. The caller of land holds the mutation lock.
 */
import { join } from "node:path";

import { createLogger } from "./logger.js";
import { OTAManager } from "./ota-update.js";
import { validateExtractedUpdate } from "./update-extracted-validation.js";
import { syncLiveDeps } from "./update-live-deps.js";
import type { GitUpdateResult } from "./update-pipeline.js";
import type { StagedRollingUpdate, StagedUpdate } from "./update-staging.js";
import { updateStep } from "./update-progress.js";

const logger = createLogger("update-pipeline");

export interface PrepareRollingResult extends GitUpdateResult {
  staged?: StagedRollingUpdate;
}

export async function prepareRollingUpdate(installDir: string, authToken: string, ota = new OTAManager()): Promise<PrepareRollingResult> {
  const installed = (await ota.readInstalledCommit()) || "";
  const { commit } = await ota.resolveRollingTarget();
  const ids = { fromCommit: installed.slice(0, 7), toCommit: commit.slice(0, 7) };
  if (installed && installed === commit) return { ok: true, ...ids, detail: "Already up to date." };
  updateStep("fetch");
  const tarPath = await ota.downloadRollingSource(commit);
  updateStep("copy");
  let desktopDepsChanged = false;
  let gates: StagedRollingUpdate["gates"] | undefined;
  const staged = await ota.stageExtract(tarPath, commit, async (extractDir) => {
    const verdict = await validateExtractedUpdate(extractDir, installDir, authToken);
    desktopDepsChanged = verdict.desktopDepsChanged;
    gates = verdict.gates;
    return verdict;
  });
  logger.info(`[update] prepared ${commit.slice(0, 7)} in ${staged.extractDir}`);
  return {
    ok: true, ...ids, gates, detail: "Update ready to install.",
    staged: {
      route: "rolling", base: installed, target: commit, upstream: commit, preparedAt: Date.now(), gates: gates!,
      extractDir: staged.extractDir, version: staged.version, depsChanged: staged.depsChanged, desktopDepsChanged,
    },
  };
}

export interface LandRollingResult extends GitUpdateResult {
  stale?: boolean;
}

export async function landRollingUpdate(staged: StagedRollingUpdate, installDir: string, ota = new OTAManager()): Promise<LandRollingResult> {
  const ids = { fromCommit: staged.base.slice(0, 7), toCommit: staged.target.slice(0, 7), gates: staged.gates };
  updateStep("land");
  if (((await ota.readInstalledCommit()) || "") !== staged.base) {
    return { ok: false, stale: true, ...ids, detail: "This install changed since the update was prepared; it is prepared again." };
  }
  await ota.landExtract(staged.extractDir, installDir, staged.base || "rolling", staged.target, staged.version);
  try {
    if (staged.depsChanged) await syncLiveDeps(installDir);
    if (staged.desktopDepsChanged) await syncLiveDeps(join(installDir, "desktop"));
    await ota.writeInstalledCommit(staged.target);
    await ota.confirmUpdate(staged.target);
  } catch (error) {
    await ota.rollbackUpdate(installDir, staged.target);
    throw new Error(`Update rolled back after post-copy verification failed: ${(error as Error).message}`);
  }
  logger.info(`[update] rolling applied ${ids.fromCommit || "(fresh)"} → ${ids.toCommit}`);
  return { ok: true, ...ids, detail: "Updated from main (validated) — relaunch to finish." };
}

/** Removes a prepared download that will not be landed. */
export async function discardRollingStaged(staged: StagedUpdate, ota = new OTAManager()): Promise<void> {
  if (staged.route === "rolling") await ota.discardExtract(staged.extractDir);
}
