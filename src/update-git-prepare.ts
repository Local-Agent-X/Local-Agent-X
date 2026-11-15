/**
 * Git route, first half: everything an update needs before it may touch the
 * live install — fetch, an isolated worktree with the update merged in, and the
 * deps / build / bind / smoke gates — kept ready for landing
 * (update-git-land.ts). Runs on the click (inside applyGitUpdate) and in the
 * background (the update-prepare job), the same code both ways. Never touches
 * the live checkout, so it takes no mutation lock.
 */
import type { ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";

import { cleanupWorktree, createNamedWorktree, runDesktopTscBuildAsync } from "./agency/worktree.js";
import { linkDirectoryInto } from "./agency/worktree-junctions.js";
import { createLogger } from "./logger.js";
import { gateBind, gateBuild, gateDeps, gateSmoke, killProbe, SKIPPED_GATE, BUILD_TIMEOUT_MS } from "./self-edit/sandbox-gates.js";
import { nowSlug, pickProbePort } from "./self-edit/sandbox-naming.js";
import { getSetting } from "./settings.js";
import { rmUpdatePathRetry } from "./update-extracted-validation.js";
import { updateGit } from "./update-live-deps.js";
import type { GitUpdateResult, UpdateGates } from "./update-pipeline.js";
import type { StagedGitUpdate, StagedUpdate } from "./update-staging.js";

const logger = createLogger("update-pipeline");

export interface PrepareGitResult extends GitUpdateResult {
  /** Set when every gate passed: the candidate, ready to land. */
  staged?: StagedGitUpdate;
}

/** Why an install can't take an update without the user, or null when it can. */
async function heldReason(repoRoot: string): Promise<string | null> {
  // Tracked changes only (-uno): untracked files can't corrupt a merge of
  // tracked content, and a rare add/untracked filename collision makes the
  // landing merge itself fail loudly. Counting untracked here left installs
  // permanently un-updatable over stray files (live case: a workspace
  // symlink the old .gitignore pattern didn't cover).
  if (await updateGit("git status --porcelain --untracked-files=no", repoRoot)) {
    return "Local uncommitted changes to tracked files detected. Commit or stash before updating.";
  }
  const localAhead = await updateGit("git rev-list --count origin/main..HEAD", repoRoot) !== "0";
  if (localAhead && getSetting("developer_mode") !== true) {
    return "This install has local commits not on origin/main (likely past self_edits) and developer_mode is off. " +
      "Enable developer_mode to merge the update with the local changes, or reset to the official release " +
      "(`git log origin/main..HEAD` shows what would be discarded, then `git reset --hard origin/main`).";
  }
  return null;
}

/**
 * Fetch, then build and gate the update in a worktree it keeps. `owner` tags
 * the worktree (the click passes its lock's nonce; the background job its own).
 */
export async function prepareGitUpdate(repoRoot: string, authToken: string, owner: string): Promise<PrepareGitResult> {
  await updateGit("git fetch origin main --quiet", repoRoot);
  const base = await updateGit("git rev-parse HEAD", repoRoot);
  const remote = await updateGit("git rev-parse origin/main", repoRoot);
  const ids = { fromCommit: base.slice(0, 7), toCommit: remote.slice(0, 7) };
  if (base === remote) return { ok: true, ...ids, detail: "Already up to date." };
  const held = await heldReason(repoRoot);
  if (held) return { ok: false, held: true, ...ids, detail: held };

  const name = `update-${nowSlug()}`;
  const wt = createNamedWorktree(name, `update/${nowSlug()}`, repoRoot, owner);
  if (!wt) return { ok: false, ...ids, detail: "Failed to create update worktree — see server logs." };

  // Merge the update into the candidate tree. With no local commits this
  // fast-forwards the branch to origin/main exactly; with developer_mode
  // commits it produces the merged tree the gates need to validate. A
  // conflict means the update genuinely collides with a local edit — hold
  // with the resolution path instead of silently picking a side.
  try {
    await updateGit("git merge origin/main --no-edit", wt.path);
  } catch (e) {
    try { await updateGit("git merge --abort", wt.path); } catch { /* nothing in progress */ }
    cleanupWorktree(name);
    const msg = e as { stderr?: string; stdout?: string; message: string };
    return {
      ok: false, held: true, ...ids,
      detail: `Update conflicts with local commits and was NOT applied.\n${(msg.stdout || msg.stderr || msg.message).slice(-600)}\n` +
        "Resolve manually: git merge origin/main (in the repo), fix conflicts, commit — then restart.",
    };
  }

  const gated = await runGitGates(name, authToken, remote);
  if (!gated.ok) { cleanupWorktree(name); return { ok: false, ...ids, gates: gated.gates, detail: gated.detail }; }

  const changed = (await updateGit(`git diff --name-only ${base} HEAD`, wt.path)).split("\n").filter(Boolean);
  const depsChanged = changed.some((f) => f === "package.json" || f === "package-lock.json");
  const desktopBuilt = await prebuildDesktop(repoRoot, wt.path, changed);
  const target = await updateGit("git rev-parse HEAD", wt.path);
  logger.info(`[update] prepared ${remote.slice(0, 7)} in ${name}`);
  return {
    ok: true, ...ids, gates: gated.gates, detail: "Update ready to install.",
    staged: {
      route: "git", base, target, preparedAt: Date.now(), gates: gated.gates,
      worktree: name, worktreePath: wt.path, branch: wt.branch, depsChanged, desktopBuilt,
    },
  };
}

/** The four gates on a prepared worktree; the probe server never outlives the call. */
async function runGitGates(name: string, authToken: string, remote: string): Promise<{ ok: boolean; gates: UpdateGates; detail: string }> {
  logger.info(`[update] validating ${remote.slice(0, 7)} in worktree ${name}`);
  let probeProc: ChildProcess | null = null;
  let probeDataDir: string | null = null;
  try {
    const deps = await gateDeps(name);
    if (!deps.skipped && !deps.ok) return { ok: false, gates: { deps, build: SKIPPED_GATE, bind: SKIPPED_GATE, smoke: SKIPPED_GATE }, detail: `Update blocked at deps gate: ${deps.detail.slice(0, 600)}` };
    const build = await gateBuild(name, undefined, "build:runtime");
    if (!build.ok) return { ok: false, gates: { deps, build, bind: SKIPPED_GATE, smoke: SKIPPED_GATE }, detail: `Update blocked at build gate: ${build.detail.slice(0, 600)}` };
    const port = await pickProbePort();
    const bindOutcome = await gateBind(name, port, authToken);
    probeProc = bindOutcome.proc;
    probeDataDir = bindOutcome.dataDir;
    if (!bindOutcome.result.ok) return { ok: false, gates: { deps, build, bind: bindOutcome.result, smoke: SKIPPED_GATE }, detail: `Update blocked at bind gate: ${bindOutcome.result.detail.slice(0, 600)}` };
    const smoke = await gateSmoke(port, authToken);
    const gates = { deps, build, bind: bindOutcome.result, smoke };
    if (!smoke.ok) return { ok: false, gates, detail: `Update blocked at smoke gate: ${smoke.detail.slice(0, 600)}` };
    return { ok: true, gates, detail: "all gates passed" };
  } finally {
    await killProbe(probeProc);
    if (probeDataDir) await rmUpdatePathRetry(probeDataDir, "probe data dir");
  }
}

/**
 * Build desktop/dist in the worktree when the update changes the Electron
 * main, so landing copies it and the restart is one clean boot (no reconcile
 * rebuild + relaunch). Skipped when the desktop's own dependencies changed:
 * those are installed by the next launch's reconcile, which then builds it.
 * A failed build is not an update failure; reconcile rebuilds at next launch.
 */
async function prebuildDesktop(repoRoot: string, wtPath: string, changed: string[]): Promise<boolean> {
  if (!changed.some((f) => f.startsWith("desktop/src/"))) return false;
  if (changed.some((f) => f === "desktop/package.json" || f === "desktop/package-lock.json")) return false;
  const liveDeps = join(repoRoot, "desktop", "node_modules");
  if (!existsSync(liveDeps)) return false;
  linkDirectoryInto(liveDeps, join(wtPath, "desktop", "node_modules"));
  const dt = await runDesktopTscBuildAsync(wtPath, BUILD_TIMEOUT_MS);
  if (!dt.ok) logger.warn(`[update] desktop prebuild failed in the candidate; the next launch rebuilds it: ${dt.detail.slice(0, 300)}`);
  return dt.ok;
}

/** Removes a prepared git candidate: its worktree and its branch (nothing on it to keep). */
export async function discardGitStaged(staged: StagedUpdate, repoRoot: string): Promise<void> {
  if (staged.route !== "git") return;
  cleanupWorktree(staged.worktree);
  await updateGit(`git branch -D ${staged.branch}`, repoRoot).catch(() => { /* already gone */ });
}
