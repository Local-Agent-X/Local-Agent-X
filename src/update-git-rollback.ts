import { getBranchHead, revertBranchTo } from "./agency/worktree.js";
import {
  cancelPreparedUpdateMerge, prepareUpdateMerge, recordMerge,
} from "./self-edit/rollback.js";

export interface PreparedUpdateLanding { repoRoot: string; baseBranch: string; sha: string }

export function prepareUpdateLanding(
  candidatePath: string,
  merge: PreparedUpdateLanding,
): PreparedUpdateLanding {
  prepareUpdateMerge({
    preSha: merge.sha,
    postSha: getBranchHead(candidatePath, "HEAD"),
    baseBranch: merge.baseBranch,
    repoRoot: merge.repoRoot,
    files: 0,
    ts: new Date().toISOString(),
  });
  return merge;
}

export function cancelUpdateLanding(merge: PreparedUpdateLanding): void {
  cancelPreparedUpdateMerge(merge.sha);
}

export function restoreUpdateLanding(merge: PreparedUpdateLanding): void {
  revertBranchTo(merge.repoRoot, merge.baseBranch, merge.sha);
  cancelPreparedUpdateMerge(merge.sha);
}

export function confirmUpdateLanding(merge: PreparedUpdateLanding, postSha: string, files: number): void {
  recordMerge({
    preSha: merge.sha, postSha, baseBranch: merge.baseBranch,
    repoRoot: merge.repoRoot, files, ts: new Date().toISOString(),
  });
}
