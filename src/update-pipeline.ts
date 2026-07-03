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

import { execSync, type ChildProcess } from "node:child_process";
import { existsSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import {
  createNamedWorktree, mergeWorktree, cleanupWorktree, getMergeBaseInfo,
  getBranchHead, revertBranchTo, runRepoBuild, runDesktopTscBuild,
} from "./agency/worktree.js";
import { OTAManager } from "./ota-update.js";
import { linkDirectoryInto, unlinkSharedJunctions } from "./agency/worktree-junctions.js";
import { gateDeps, gateBuild, gateBuildAt, gateBind, gateBindAt, gateSmoke, killProbe, SKIPPED_GATE, BUILD_TIMEOUT_MS, type GateResult } from "./self-edit-sandbox-gates.js";
import { acquireGlobalSelfEditLock, releaseGlobalSelfEditLock } from "./self-edit/global-lock.js";
import { recordMerge } from "./self-edit-rollback.js";
import { nowSlug, pickProbePort } from "./self-edit-sandbox-naming.js";
import { getSetting } from "./settings.js";
import { createLogger } from "./logger.js";

const logger = createLogger("update-pipeline");
const GIT_TIMEOUT_MS = 60_000;
const UPDATE_BUSY =
  "Another update or self_edit is currently running on this machine. " +
  "Updates are applied one at a time — wait for it to finish, then try again.";

/**
 * Best-effort recursive delete with backoff. On Windows a just-killed probe's
 * file handles linger for a second or two, so an immediate rm throws EBUSY —
 * and a cleanup failure must never decide the update's outcome. Retries, then
 * logs and gives up; leftover dirs under the updates dir are inert.
 */
async function rmRetry(path: string, label: string): Promise<void> {
  for (let attempt = 0; ; attempt++) {
    try { rmSync(path, { recursive: true, force: true }); return; }
    catch (e) {
      if (attempt >= 5) {
        logger.warn(`[update] could not remove ${label} at ${path}: ${(e as Error).message}`);
        return;
      }
      await new Promise(resolve => setTimeout(resolve, 600));
    }
  }
}

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

function sh(cmd: string, cwd: string, timeoutMs = GIT_TIMEOUT_MS): string {
  return execSync(cmd, { cwd, encoding: "utf-8", timeout: timeoutMs, windowsHide: true, maxBuffer: 10 * 1024 * 1024 }).trim();
}

/** A Windows file lock (a loaded native module, AV, or the file indexer), as
 *  opposed to a real dependency error. The update can DEFER these to next-launch
 *  reconcile; it must NOT revert over them. */
export function isDeferrableFileLock(msg: string): boolean {
  return /EBUSY|EPERM|EACCES|resource busy or locked/i.test(msg);
}

/**
 * Sync the LIVE install's node_modules to the just-applied lockfile.
 *
 * `npm install` (incremental), NEVER `npm ci`: ci wipes node_modules and so must
 * unlink EVERY native module — including ones the running server holds loaded
 * (sqlite-vec's vec0.dll) — which Windows refuses with EPERM. install touches
 * only what changed.
 *
 * Returns deferred=true when the ONLY failure was a Windows file lock on a
 * loaded native module the update bumped: the lockfile on disk is already
 * current, and the next launch's pre-server reconcile (desktop/src/reconcile.ts)
 * reinstalls deps BEFORE the server child loads any native module, where the
 * in-place swap is safe. Rethrows any other npm error (a real dependency
 * problem). Shared by the git and rolling paths so both defer identically
 * instead of one reverting where the other defers.
 */
function syncLiveDeps(installDir: string): { deferred: boolean } {
  try {
    execSync("npm install", { cwd: installDir, encoding: "utf-8", timeout: BUILD_TIMEOUT_MS, windowsHide: true, maxBuffer: 10 * 1024 * 1024 });
    return { deferred: false };
  } catch (e) {
    const msg = (e as Error).message || "";
    if (!isDeferrableFileLock(msg)) throw e;
    logger.warn(`[update] live npm install hit a file lock; deferring deps to next-launch reconcile: ${msg.split("\n")[0]}`);
    return { deferred: true };
  }
}

export async function applyGitUpdate(repoRoot: string, authToken: string): Promise<GitUpdateResult> {
  // Same machine-wide lock as the self_edit sandbox: both build into the
  // shared node_modules and mutate main, so they must never run concurrently.
  const lock = acquireGlobalSelfEditLock({ task: "platform update" });
  if (!lock.acquired) {
    logger.info(`[update] refused — lock held by ${JSON.stringify(lock.holder ?? "unknown")}`);
    return { ok: false, held: true, fromCommit: "", toCommit: "", detail: UPDATE_BUSY };
  }

  const name = `update-${nowSlug()}`;
  const branch = `update/${nowSlug()}`;
  let probeProc: ChildProcess | null = null;
  let probeDataDir: string | null = null;

  try {
    sh("git fetch origin main --quiet", repoRoot);
    const fromCommit = sh("git rev-parse HEAD", repoRoot);
    const remote = sh("git rev-parse origin/main", repoRoot);
    if (fromCommit === remote) {
      return { ok: true, fromCommit: fromCommit.slice(0, 7), toCommit: remote.slice(0, 7), detail: "Already up to date." };
    }
    // Tracked changes only (-uno): untracked files can't corrupt a merge of
    // tracked content, and a rare add/untracked filename collision makes the
    // landing merge itself fail loudly. Counting untracked here left installs
    // permanently un-updatable over stray files (live case: a workspace
    // symlink the old .gitignore pattern didn't cover).
    const dirty = sh("git status --porcelain --untracked-files=no", repoRoot);
    if (dirty) {
      return { ok: false, held: true, fromCommit: fromCommit.slice(0, 7), toCommit: remote.slice(0, 7), detail: "Local uncommitted changes to tracked files detected. Commit or stash before updating." };
    }
    const localAhead = sh("git rev-list --count origin/main..HEAD", repoRoot) !== "0";
    if (localAhead && getSetting("developer_mode") !== true) {
      return {
        ok: false, held: true, fromCommit: fromCommit.slice(0, 7), toCommit: remote.slice(0, 7),
        detail:
          "This install has local commits not on origin/main (likely past self_edits) and developer_mode is off. " +
          "Enable developer_mode to merge the update with the local changes, or reset to the official release " +
          "(`git log origin/main..HEAD` shows what would be discarded, then `git reset --hard origin/main`).",
      };
    }

    const wt = createNamedWorktree(name, branch);
    if (!wt) {
      return { ok: false, fromCommit: fromCommit.slice(0, 7), toCommit: remote.slice(0, 7), detail: "Failed to create update worktree — see server logs." };
    }

    // Merge the update into the candidate tree. With no local commits this
    // fast-forwards the branch to origin/main exactly; with developer_mode
    // commits it produces the merged tree the gates need to validate. A
    // conflict means the update genuinely collides with a local edit — hold
    // with the resolution path instead of silently picking a side.
    try {
      sh("git merge origin/main --no-edit", wt.path);
    } catch (e) {
      try { sh("git merge --abort", wt.path); } catch { /* nothing in progress */ }
      cleanupWorktree(name);
      const msg = (e as { stderr?: string; stdout?: string; message: string });
      return {
        ok: false, held: true, fromCommit: fromCommit.slice(0, 7), toCommit: remote.slice(0, 7),
        detail:
          `Update conflicts with local commits and was NOT applied.\n` +
          `${(msg.stdout || msg.stderr || msg.message).slice(-600)}\n` +
          `Resolve manually: git merge origin/main (in the repo), fix conflicts, commit — then restart.`,
      };
    }

    logger.info(`[update] validating ${remote.slice(0, 7)} in worktree ${name}`);
    const deps = gateDeps(name);
    if (!deps.skipped && !deps.ok) {
      cleanupWorktree(name);
      return { ok: false, fromCommit: fromCommit.slice(0, 7), toCommit: remote.slice(0, 7), gates: { deps, build: SKIPPED_GATE, bind: SKIPPED_GATE, smoke: SKIPPED_GATE }, detail: `Update blocked at deps gate: ${deps.detail.slice(0, 600)}` };
    }
    const build = gateBuild(name);
    if (!build.ok) {
      cleanupWorktree(name);
      return { ok: false, fromCommit: fromCommit.slice(0, 7), toCommit: remote.slice(0, 7), gates: { deps, build, bind: SKIPPED_GATE, smoke: SKIPPED_GATE }, detail: `Update blocked at build gate: ${build.detail.slice(0, 600)}` };
    }
    const port = await pickProbePort();
    const bindOutcome = await gateBind(name, port, authToken);
    probeProc = bindOutcome.proc;
    probeDataDir = bindOutcome.dataDir;
    if (!bindOutcome.result.ok) {
      cleanupWorktree(name);
      return { ok: false, fromCommit: fromCommit.slice(0, 7), toCommit: remote.slice(0, 7), gates: { deps, build, bind: bindOutcome.result, smoke: SKIPPED_GATE }, detail: `Update blocked at bind gate: ${bindOutcome.result.detail.slice(0, 600)}` };
    }
    const smoke = await gateSmoke(port, authToken);
    killProbe(probeProc);
    probeProc = null;
    if (!smoke.ok) {
      cleanupWorktree(name);
      return { ok: false, fromCommit: fromCommit.slice(0, 7), toCommit: remote.slice(0, 7), gates: { deps, build, bind: bindOutcome.result, smoke }, detail: `Update blocked at smoke gate: ${smoke.detail.slice(0, 600)}` };
    }
    const gates: UpdateGates = { deps, build, bind: bindOutcome.result, smoke };

    const mergeInfo = getMergeBaseInfo(name);
    const merge = mergeWorktree(name);
    if (!merge.merged) {
      return { ok: false, fromCommit: fromCommit.slice(0, 7), toCommit: remote.slice(0, 7), gates, detail: `Gates passed but landing failed: ${merge.error || "unknown"}` };
    }

    // The gated install ran against the worktree's ISOLATED deps; the live
    // tree's node_modules still has the old set. Sync it before rebuilding via
    // syncLiveDeps — a Windows file lock on a loaded native module the update
    // bumped DEFERS to next-launch reconcile (same as the rolling path) instead
    // of reverting; only a real dependency error reverts.
    if (!deps.skipped) {
      try {
        syncLiveDeps(repoRoot);
      } catch (e) {
        if (mergeInfo) {
          revertBranchTo(mergeInfo.repoRoot, mergeInfo.baseBranch, mergeInfo.sha);
          try { syncLiveDeps(repoRoot); } catch { /* old lockfile restored, next boot retries */ }
        }
        return { ok: false, fromCommit: fromCommit.slice(0, 7), toCommit: remote.slice(0, 7), gates, detail: `Update reverted — dependency install on the live tree failed: ${(e as Error).message.slice(0, 600)}` };
      }
    }
    if (mergeInfo) {
      const rebuilt = runRepoBuild(mergeInfo.repoRoot, BUILD_TIMEOUT_MS);
      if (!rebuilt.ok) {
        revertBranchTo(mergeInfo.repoRoot, mergeInfo.baseBranch, mergeInfo.sha);
        if (!deps.skipped) { try { syncLiveDeps(repoRoot); } catch { /* old lockfile restored, next boot retries */ } }
        return { ok: false, fromCommit: fromCommit.slice(0, 7), toCommit: remote.slice(0, 7), gates, detail: `Update reverted — post-merge rebuild failed: ${rebuilt.detail.slice(0, 600)}` };
      }
      const postSha = getBranchHead(mergeInfo.repoRoot, mergeInfo.baseBranch);
      recordMerge({ preSha: mergeInfo.sha, postSha, baseBranch: mergeInfo.baseBranch, repoRoot: mergeInfo.repoRoot, files: merge.files, ts: new Date().toISOString() });

      // Pre-build desktop/dist for updates that touch the Electron main, so the
      // restart is a single clean boot — reconcile's desktopDistIsFresh skip
      // then avoids the rebuild + relaunch (the second cold boot). Runs before
      // this function returns "Restart to finish", so the user can't restart
      // into a half-written dist. Non-fatal: the server update already landed;
      // a failure leaves the prior dist intact (--noEmitOnError) and next-boot
      // reconcile rebuilds it.
      if (sh(`git diff --name-only ${mergeInfo.sha} ${postSha} -- desktop/src`, repoRoot)) {
        const dt = runDesktopTscBuild(repoRoot, BUILD_TIMEOUT_MS);
        if (dt.ok) logger.info(`[update] pre-built desktop/dist for single-boot restart`);
        else logger.warn(`[update] desktop pre-build failed; reconcile will rebuild next boot: ${dt.detail.slice(0, 300)}`);
      }
    }

    const toCommit = sh("git rev-parse HEAD", repoRoot);
    logger.info(`[update] applied ${fromCommit.slice(0, 7)} → ${toCommit.slice(0, 7)} (${merge.files} files)`);
    return { ok: true, fromCommit: fromCommit.slice(0, 7), toCommit: toCommit.slice(0, 7), gates, detail: `Updated (${merge.files} files). Restart to finish.` };
  } catch (e) {
    return { ok: false, fromCommit: "", toCommit: "", detail: `Update pipeline crashed: ${(e as Error).message}` };
  } finally {
    killProbe(probeProc);
    if (probeDataDir) await rmRetry(probeDataDir, "probe data dir");
    releaseGlobalSelfEditLock(lock.nonce);
  }
}

/**
 * Tarball (rolling-channel) update behind the same machine-wide lock as the
 * git path and self_edit. Concurrent Update clicks were racing each other's
 * extract dirs and probes into EBUSY before this existed.
 */
export async function applyRollingUpdate(installDir: string, authToken: string): Promise<GitUpdateResult> {
  const lock = acquireGlobalSelfEditLock({ task: "platform update (rolling)" });
  if (!lock.acquired) {
    logger.info(`[update] rolling refused — lock held by ${JSON.stringify(lock.holder ?? "unknown")}`);
    return { ok: false, held: true, fromCommit: "", toCommit: "", detail: UPDATE_BUSY };
  }
  try {
    const ota = new OTAManager();
    const installed = (await ota.readInstalledCommit()) || "";
    const { commit } = await ota.checkMainCommit();
    if (installed && installed === commit) {
      return { ok: true, fromCommit: installed.slice(0, 7), toCommit: commit.slice(0, 7), detail: "Already up to date." };
    }
    const tarPath = await ota.downloadMainTarball(commit);
    const { depsChanged } = await ota.applyUpdate(
      tarPath, installDir, installed || "rolling", commit,
      (extractDir) => validateExtractedUpdate(extractDir, installDir, authToken),
    );
    if (depsChanged) {
      // The gated tree validated against fresh deps; sync the live install's
      // node_modules to the new lockfile. A file lock on a loaded native module
      // defers to next-launch reconcile (see syncLiveDeps).
      syncLiveDeps(installDir);
    }
    await ota.writeInstalledCommit(commit);
    logger.info(`[update] rolling applied ${installed.slice(0, 7) || "(fresh)"} → ${commit.slice(0, 7)}`);
    return { ok: true, fromCommit: installed.slice(0, 7), toCommit: commit.slice(0, 7), detail: "Updated from main (validated) — relaunch to finish." };
  } catch (e) {
    return { ok: false, fromCommit: "", toCommit: "", detail: (e as Error).message };
  } finally {
    releaseGlobalSelfEditLock(lock.nonce);
  }
}

// ── Tarball (OTA) validation ───────────────────────────────────────────────

export interface ExtractValidation { ok: boolean; detail: string; depsChanged: boolean; gates: UpdateGates }

function fileDiffers(a: string, b: string): boolean {
  const ra = existsSync(a) ? readFileSync(a, "utf-8") : "";
  const rb = existsSync(b) ? readFileSync(b, "utf-8") : "";
  return ra !== rb;
}

/**
 * Gate an extracted update tree before OTAManager copies it over the install.
 * Deps come from the live install via junction when manifests are unchanged,
 * or a real isolated `npm ci` when they changed. node_modules (junction or
 * real) is ALWAYS removed before returning so the subsequent overlap-backup +
 * copy never walks dependency trees.
 */
export async function validateExtractedUpdate(extractDir: string, installDir: string, authToken: string): Promise<ExtractValidation> {
  let probeProc: ChildProcess | null = null;
  let probeDataDir: string | null = null;
  const depsChanged =
    fileDiffers(join(extractDir, "package.json"), join(installDir, "package.json")) ||
    fileDiffers(join(extractDir, "package-lock.json"), join(installDir, "package-lock.json"));

  try {
    let deps: GateResult;
    if (depsChanged) {
      const start = Date.now();
      try {
        execSync("npm ci", { cwd: extractDir, encoding: "utf-8", timeout: BUILD_TIMEOUT_MS, windowsHide: true, maxBuffer: 10 * 1024 * 1024 });
        deps = { ok: true, skipped: false, durationMs: Date.now() - start, detail: "isolated npm ci passed" };
      } catch (e) {
        const err = e as { stdout?: string; stderr?: string; message: string };
        const detail = (err.stderr || err.stdout || err.message).slice(-1500);
        return { ok: false, depsChanged, detail: `deps gate failed: ${detail.slice(0, 600)}`, gates: { deps: { ok: false, skipped: false, durationMs: Date.now() - start, detail }, build: SKIPPED_GATE, bind: SKIPPED_GATE, smoke: SKIPPED_GATE } };
      }
    } else {
      deps = { ok: true, skipped: true, durationMs: 0, detail: "no dependency changes" };
      linkDirectoryInto(join(installDir, "node_modules"), join(extractDir, "node_modules"));
      const pkgsDir = join(installDir, "packages");
      if (existsSync(pkgsDir)) {
        for (const pkg of readdirSync(pkgsDir)) {
          const srcNm = join(pkgsDir, pkg, "node_modules");
          if (statSync(join(pkgsDir, pkg)).isDirectory() && existsSync(srcNm)) {
            linkDirectoryInto(srcNm, join(extractDir, "packages", pkg, "node_modules"));
          }
        }
      }
    }

    const build = gateBuildAt(extractDir);
    if (!build.ok) {
      return { ok: false, depsChanged, detail: `build gate failed: ${build.detail.slice(0, 600)}`, gates: { deps, build, bind: SKIPPED_GATE, smoke: SKIPPED_GATE } };
    }
    const port = await pickProbePort();
    const bindOutcome = await gateBindAt(extractDir, port, authToken);
    probeProc = bindOutcome.proc;
    probeDataDir = bindOutcome.dataDir;
    if (!bindOutcome.result.ok) {
      return { ok: false, depsChanged, detail: `bind gate failed: ${bindOutcome.result.detail.slice(0, 600)}`, gates: { deps, build, bind: bindOutcome.result, smoke: SKIPPED_GATE } };
    }
    const smoke = await gateSmoke(port, authToken);
    if (!smoke.ok) {
      return { ok: false, depsChanged, detail: `smoke gate failed: ${smoke.detail.slice(0, 600)}`, gates: { deps, build, bind: bindOutcome.result, smoke } };
    }
    return { ok: true, depsChanged, detail: "all gates passed", gates: { deps, build, bind: bindOutcome.result, smoke } };
  } finally {
    killProbe(probeProc);
    if (probeDataDir) await rmRetry(probeDataDir, "probe data dir");
    // Junction must go BEFORE any caller rm/copy walks extractDir — a walked
    // junction reaches the live install's real node_modules. A real isolated
    // install is removed too: the install dir gets its deps via `npm ci`
    // post-copy, not via a multi-gigabyte file copy.
    const stuck = unlinkSharedJunctions(extractDir);
    if (stuck.length === 0) {
      const nm = join(extractDir, "node_modules");
      if (existsSync(nm)) await rmRetry(nm, "extracted node_modules");
    } else {
      logger.error(`[update] junction(s) still live in extract dir — leaving node_modules untouched: ${stuck.join(", ")}`);
    }
  }
}
