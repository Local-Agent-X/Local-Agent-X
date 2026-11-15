/**
 * The one prepared update: a version validated and built ahead of the click,
 * so clicking Update only lands it (update-pipeline.ts applyUpdate paths).
 *
 * One slot, always the newest. A newer version is prepared while the older
 * stays ready; when the newer is ready it takes the slot and the older is
 * discarded, so skipped updates never stack. Held in memory: a prepared git
 * worktree does not outlive the process (the boot worktree sweep reclaims it),
 * so after a restart the update is prepared again.
 *
 * Landing checks that the install is still on the commit a candidate was
 * prepared from (`base`); one prepared before a self_edit or a local commit is
 * not landed, and the click runs the full path instead.
 */
import { createLogger } from "./logger.js";
import type { UpdateGates } from "./update-pipeline.js";

const logger = createLogger("update-staging");

interface StagedBase {
  /** The install's commit when this was prepared: landing requires it unchanged. */
  base: string;
  /** The commit this candidate installs. */
  target: string;
  preparedAt: number;
  gates: UpdateGates;
}

export interface StagedGitUpdate extends StagedBase {
  route: "git";
  /** The worktree's registry name and its path. */
  worktree: string;
  worktreePath: string;
  branch: string;
  /** package.json / package-lock.json changed: the live tree needs an install. */
  depsChanged: boolean;
  /** desktop/src changed and desktop/dist was built in the worktree. */
  desktopBuilt: boolean;
}

export interface StagedRollingUpdate extends StagedBase {
  route: "rolling";
  /** The extracted, validated tree waiting to be copied over the install. */
  extractDir: string;
  depsChanged: boolean;
  desktopDepsChanged: boolean;
}

export type StagedUpdate = StagedGitUpdate | StagedRollingUpdate;

/** Removes a candidate's files (its worktree or extract dir). */
export type DiscardStaged = (staged: StagedUpdate) => Promise<void>;

let ready: StagedUpdate | null = null;
let preparing: string | null = null;

/** The prepared update, if one is ready. */
export function readyUpdate(): StagedUpdate | null {
  return ready;
}

/** The target being prepared right now, or null. */
export function preparingTarget(): string | null {
  return preparing;
}

export function markPreparing(target: string | null): void {
  preparing = target;
}

/** `next` is ready: it takes the slot, and the candidate it replaces is discarded. */
export async function stageReady(next: StagedUpdate, discard: DiscardStaged): Promise<void> {
  const old = ready;
  ready = next;
  if (old && old !== next) {
    await discard(old).catch((e) => logger.warn(`[update] could not discard the older prepared update ${old.target.slice(0, 7)}: ${(e as Error).message}`));
  }
}

/** Takes the ready candidate out of the slot for landing; landing owns it from here. */
export function takeReady(): StagedUpdate | null {
  const r = ready;
  ready = null;
  return r;
}

/** Drops the ready candidate (it can no longer land) and removes its files. */
export async function dropReady(discard: DiscardStaged): Promise<void> {
  const r = takeReady();
  if (r) await discard(r).catch((e) => logger.warn(`[update] could not discard prepared update ${r.target.slice(0, 7)}: ${(e as Error).message}`));
}
