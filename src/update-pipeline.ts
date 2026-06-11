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
  getBranchHead, revertBranchTo, runRepoBuild,
} from "./agency/worktree.js";
import { linkDirectoryInto, unlinkSharedJunctions } from "./agency/worktree-junctions.js";
import { gateDeps, gateBuild, gateBuildAt, gateBind, gateBindAt, gateSmoke, killProbe, SKIPPED_GATE, BUILD_TIMEOUT_MS, type GateResult } from "./self-edit-sandbox-gates.js";
import { acquireGlobalSelfEditLock, releaseGlobalSelfEditLock, formatGlobalLockBusy } from "./self-edit/global-lock.js";
import { recordMerge } from "./self-edit-rollback.js";
import { nowSlug, pickProbePort } from "./self-edit-sandbox-naming.js";
import { getSetting } from "./settings.js";
import { createLogger } from "./logger.js";

const logger = createLogger("update-pipeline");
const GIT_TIMEOUT_MS = 60_000;

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

export async function applyGitUpdate(repoRoot: string, authToken: string): Promise<GitUpdateResult> {
  // Same machine-wide lock as the self_edit sandbox: both build into the
  // shared node_modules and mutate main, so they must never run concurrently.
  const lock = acquireGlobalSelfEditLock({ task: "platform update" });
  if (!lock.acquired) {
    return { ok: false, held: true, fromCommit: "", toCommit: "", detail: formatGlobalLockBusy(lock.holder, "platform update") };
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
    const dirty = sh("git status --porcelain", repoRoot);
    if (dirty) {
      return { ok: false, held: true, fromCommit: fromCommit.slice(0, 7), toCommit: remote.slice(0, 7), detail: "Local uncommitted changes detected. Commit or stash before updating." };
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
    // tree's node_modules still has the old set. Sync it before rebuilding.
    if (!deps.skipped) {
      try {
        sh("npm ci", repoRoot, BUILD_TIMEOUT_MS);
      } catch (e) {
        if (mergeInfo) {
          revertBranchTo(mergeInfo.repoRoot, mergeInfo.baseBranch, mergeInfo.sha);
          try { sh("npm ci", repoRoot, BUILD_TIMEOUT_MS); } catch { /* old lockfile restored, next boot retries */ }
        }
        return { ok: false, fromCommit: fromCommit.slice(0, 7), toCommit: remote.slice(0, 7), gates, detail: `Update reverted — dependency install on the live tree failed: ${(e as Error).message.slice(0, 600)}` };
      }
    }
    if (mergeInfo) {
      const rebuilt = runRepoBuild(mergeInfo.repoRoot, BUILD_TIMEOUT_MS);
      if (!rebuilt.ok) {
        revertBranchTo(mergeInfo.repoRoot, mergeInfo.baseBranch, mergeInfo.sha);
        if (!deps.skipped) { try { sh("npm ci", repoRoot, BUILD_TIMEOUT_MS); } catch { /* old lockfile restored, next boot retries */ } }
        return { ok: false, fromCommit: fromCommit.slice(0, 7), toCommit: remote.slice(0, 7), gates, detail: `Update reverted — post-merge rebuild failed: ${rebuilt.detail.slice(0, 600)}` };
      }
      const postSha = getBranchHead(mergeInfo.repoRoot, mergeInfo.baseBranch);
      recordMerge({ preSha: mergeInfo.sha, postSha, baseBranch: mergeInfo.baseBranch, repoRoot: mergeInfo.repoRoot, files: merge.files, ts: new Date().toISOString() });
    }

    const toCommit = sh("git rev-parse HEAD", repoRoot);
    logger.info(`[update] applied ${fromCommit.slice(0, 7)} → ${toCommit.slice(0, 7)} (${merge.files} files)`);
    return { ok: true, fromCommit: fromCommit.slice(0, 7), toCommit: toCommit.slice(0, 7), gates, detail: `Updated (${merge.files} files). Restart to finish.` };
  } catch (e) {
    return { ok: false, fromCommit: "", toCommit: "", detail: `Update pipeline crashed: ${(e as Error).message}` };
  } finally {
    killProbe(probeProc);
    if (probeDataDir) { try { rmSync(probeDataDir, { recursive: true, force: true }); } catch { /* best-effort */ } }
    releaseGlobalSelfEditLock();
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
    if (probeDataDir) { try { rmSync(probeDataDir, { recursive: true, force: true }); } catch { /* best-effort */ } }
    // Junction must go BEFORE any caller rm/copy walks extractDir — a walked
    // junction reaches the live install's real node_modules. A real isolated
    // install is removed too: the install dir gets its deps via `npm ci`
    // post-copy, not via a multi-gigabyte file copy.
    const stuck = unlinkSharedJunctions(extractDir);
    if (stuck.length === 0) {
      const nm = join(extractDir, "node_modules");
      if (existsSync(nm)) { try { rmSync(nm, { recursive: true, force: true }); } catch (e) { logger.warn(`[update] could not remove extracted node_modules: ${(e as Error).message}`); } }
    } else {
      logger.error(`[update] junction(s) still live in extract dir — leaving node_modules untouched: ${stuck.join(", ")}`);
    }
  }
}
