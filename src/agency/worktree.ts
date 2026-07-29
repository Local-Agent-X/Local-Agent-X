/**
 * Git Worktree Manager — creates isolated filesystem copies for agents.
 *
 * Flow:
 *   1. createWorktree(agentId) → creates branch + worktree in /tmp
 *   2. Agent runs with cwd override pointing to worktree
 *   3. mergeWorktree(agentId) → commits changes, merges back to stored base branch
 *   4. cleanupWorktree(agentId) → removes worktree + temp branch (preserves branch on conflict)
 *
 * Split across worktree-core (shared registry + git runner), worktree-junctions
 * (node_modules links + orphan sweep), worktree-lifecycle (create/merge/cleanup),
 * and worktree-state (inspect/mutate ops). This barrel preserves the public API.
 */

export {
  createWorktree,
  mergeWorktree,
  cleanupWorktree,
  cleanupAllWorktrees,
  createNamedWorktree,
} from "./worktree-lifecycle.js";

export {
  reconcileWorktreeBase,
  sweepOrphanWorktreeJunctions,
  type RecoveryDisposition,
  type WorktreeRecoveryResult,
} from "./worktree-recovery.js";

export {
  getWorktreePath,
  getWorktreeBaseBranch,
  getWorktreeBranch,
  getWorktreeStatus,
  getWorktreeChangedFiles,
  getMergeDeltaFiles,
  getMergeDeltaDiff,
  getMergeBaseInfo,
  getBranchHead,
  resetWorktree,
  commitInWorktree,
  isolateNodeModules,
  revertBranchTo,
  // The non-blocking runners production actually uses. They were unreachable
  // until this barrel re-exported them: every caller imports through here, so
  // an async variant missing from this list is dead code and the event loop
  // still parks for the whole build.
  runRepoBuildAsync,
  runDesktopTscBuildAsync,
  runCommandInWorktreeAsync,
  // Blocking twins, each with exactly one caller whose async conversion ripples
  // outside this change's footprint — see their @deprecated notes.
  runRepoBuild,
  runCommandInWorktree,
  changedFilesTouchDeps,
  securitySensitiveChangedFiles,
} from "./worktree-state.js";
