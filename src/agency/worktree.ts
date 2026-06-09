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

export { sweepOrphanWorktreeJunctions } from "./worktree-junctions.js";

export {
  getWorktreePath,
  getWorktreeBaseBranch,
  getWorktreeBranch,
  getWorktreeStatus,
  getWorktreeChangedFiles,
  getMergeBaseInfo,
  getBranchHead,
  resetWorktree,
  commitInWorktree,
  isolateNodeModules,
  revertBranchTo,
  runRepoBuild,
  runCommandInWorktree,
  changedFilesTouchDeps,
  securitySensitiveChangedFiles,
} from "./worktree-state.js";
