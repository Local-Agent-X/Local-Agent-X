/**
 * Prepares an available update in the background, so clicking Update only
 * lands it (update-staging.ts holds the result). Run by the update-prepare
 * job while the user is idle; the same prepare code the click runs.
 *
 * It waits until the newest version has been out for a quiet period, so a
 * burst of pushes is prepared once, not once per push. It takes no mutation
 * lock (preparing touches nothing live) and stays out of the way of one that
 * is held: a self_edit or a landing update. A click while it runs joins it
 * (joinPreparation) instead of starting a second one.
 */
import { composeGitArgs, execGit } from "./git-safety.js";
import { isLocalOnlyMode } from "./local-only-policy.js";
import { createLogger } from "./logger.js";
import { OTAManager } from "./ota-update.js";
import { isSelfEditLockHeldByLiveProcess } from "./self-edit/global-lock.js";
import { discardGitStaged, prepareGitUpdate } from "./update-git-prepare.js";
import { upstreamChangesMissing } from "./update-live-deps.js";
import { beginUpdateProgress, endUpdateProgress, promoteToInstalling } from "./update-progress.js";
import { discardRollingStaged, prepareRollingUpdate } from "./update-rolling.js";
import { markPreparing, readyUpdate, stageReady, type StagedUpdate } from "./update-staging.js";

const logger = createLogger("update-background");

/** How long the newest version must have been out before it is prepared. */
export const QUIET_PERIOD_MS = 30 * 60 * 1000;

let inflight: Promise<void> | null = null;
let joined = false;
/** When this process first saw a target, for the route that has no commit time (rolling). */
let firstSeen: { target: string; at: number } | null = null;

export type PrepareOutcome =
  | "prepared" | "local-only" | "busy" | "lock-held" | "no-update" | "already-prepared" | "quiet-period" | "failed";

/** Removes a prepared candidate's files, whichever route made it. */
export function discardStaged(staged: StagedUpdate): Promise<void> {
  return staged.route === "git" ? discardGitStaged(staged, process.cwd()) : discardRollingStaged(staged);
}

/** A click joins the preparation in flight (its progress becomes the click's), or gets null. */
export function joinPreparation(): Promise<void> | null {
  if (!inflight) return null;
  joined = true;
  promoteToInstalling();
  return inflight;
}

async function isGitCheckout(cwd: string): Promise<boolean> {
  try { await execGit(composeGitArgs("rev-parse --short HEAD"), { cwd }); return true; } catch { return false; }
}

/** The newest target and when it was published, or null when there is none to prepare. */
async function newestTarget(git: boolean, cwd: string): Promise<{ target: string; publishedAt: number } | null> {
  if (git) {
    await execGit(composeGitArgs("fetch origin main --quiet"), { cwd, timeout: 30_000 });
    if (await upstreamChangesMissing(cwd) === 0) return null;
    const [target, ct] = (await execGit(composeGitArgs(["log", "-1", "--format=%H %ct", "origin/main"]), { cwd })).trim().split(" ");
    return { target, publishedAt: Number(ct) * 1000 };
  }
  const ota = new OTAManager();
  const installed = (await ota.readInstalledCommit()) || "";
  const { commit } = await ota.resolveRollingTarget();
  if (installed === commit) return null;
  if (firstSeen?.target !== commit) firstSeen = { target: commit, at: Date.now() };
  return { target: commit, publishedAt: firstSeen.at };
}

export async function prepareUpdateInBackground(authToken: string, now: () => number = Date.now): Promise<PrepareOutcome> {
  if (isLocalOnlyMode()) return "local-only";
  if (inflight) return "busy";
  if (await isSelfEditLockHeldByLiveProcess()) return "lock-held";
  const cwd = process.cwd();
  const git = await isGitCheckout(cwd);
  const newest = await newestTarget(git, cwd).catch((e) => { logger.warn(`[update] background check failed: ${(e as Error).message}`); return null; });
  if (!newest) return "no-update";
  if (readyUpdate()?.upstream === newest.target) return "already-prepared";
  if (now() - newest.publishedAt < QUIET_PERIOD_MS) return "quiet-period";

  let outcome: PrepareOutcome = "failed";
  joined = false;
  beginUpdateProgress("preparing");
  markPreparing(newest.target);
  inflight = (async () => {
    try {
      const r = git ? await prepareGitUpdate(cwd, authToken, "update:background") : await prepareRollingUpdate(cwd, authToken);
      if (r.staged) {
        await stageReady(r.staged, discardStaged);
        outcome = "prepared";
      } else {
        logger.info(`[update] background preparation did not finish: ${r.detail.slice(0, 300)}`);
      }
    } catch (e) {
      logger.warn(`[update] background preparation failed: ${(e as Error).message}`);
    } finally {
      markPreparing(null);
      // A click that joined owns the progress run from here; it ends it.
      if (!joined) endUpdateProgress();
      inflight = null;
    }
  })();
  await inflight;
  return outcome;
}
