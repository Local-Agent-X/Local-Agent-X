/**
 * What a publish would ship, as git itself reports it. Produced by
 * change-set.ts, rendered into the reviewer's brief by
 * canonical-loop/publish-review-brief.ts, fingerprinted to key the verdict.
 */
import type { PublishKind } from "../publish-operation.js";

/** One ref a `git push` would update (from `git push --dry-run --porcelain`). */
export interface RefUpdate {
  /** Remote ref it updates: refs/heads/main, refs/tags/v1. */
  remoteRef: string;
  /** Local side of the refspec: refs/heads/main, HEAD, (delete). */
  localRef: string;
  status: "new" | "fast-forward" | "forced" | "deleted" | "up-to-date" | "rejected";
  /** Full shas where git reports them. */
  oldSha?: string;
  newSha?: string;
  /** Rejected refs: git's reason (non-fast-forward, fetch first, …). */
  note?: string;
}

export interface ChangedFile {
  /** git --name-status letter(s): A, M, D, R100, … ; "??" for untracked. */
  status: string;
  path: string;
}

export interface FileDiff {
  path: string;
  /** The file's unified diff, header included. */
  text: string;
}

/** One publishing command's slice of what ships. */
export interface ChangeSetPart {
  kind: PublishKind;
  /** The command, e.g. `git push origin main`. */
  label: string;
  repoRoot: string;
  /** git-push only. */
  refs?: RefUpdate[];
  /** What the diff is taken against, in words: "origin/main (upstream)". */
  baseLabel: string;
  commits: Array<{ sha: string; subject: string }>;
  /** More commits exist than are listed. */
  commitsTruncated: boolean;
  files: ChangedFile[];
  fileDiffs: FileDiff[];
  /** The diff text was longer than we kept; fileDiffs covers a prefix. */
  diffTruncated: boolean;
  /** Uncommitted and untracked files ship too (deploy / package publish). */
  includesWorkingTree: boolean;
  /** Content identity of this part — refs and shas, plus working-tree hashes. */
  identity: string;
}

export interface ChangeSet {
  parts: ChangeSetPart[];
  /** Publishing commands whose change set could not be determined, and why.
   *  Never silently passed: the gate reports every one. */
  unknown: Array<{ label: string; cwd: string; reason: string }>;
  /** sha256 over every part's identity and every unknown reason — the key a
   *  verdict is cached under. A changed diff is a different fingerprint. */
  fingerprint: string;
}

/** No code would ship: every ref is up to date, rejected or a deletion, and
 *  there are no commits and no working-tree changes. (A remote-branch deletion
 *  has nothing to review; the irreversible floor asks about it separately.) */
export function changeSetIsEmpty(cs: ChangeSet): boolean {
  return cs.unknown.length === 0 && cs.parts.every((p) => p.commits.length === 0 && p.files.length === 0
    && (p.refs ?? []).every((r) => r.status === "up-to-date" || r.status === "rejected" || r.status === "deleted"));
}
