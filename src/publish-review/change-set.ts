/**
 * The change set of a publish — exactly what would ship, from git itself.
 *
 *   git-push          `git push --dry-run --porcelain <the agent's args>` names
 *                     every ref it would update; each is reviewed old..new
 *                     (a new branch from its merge-base with the remote's
 *                     default branch, else from before its oldest commit not
 *                     yet on any remote).
 *   deploy /          the CLI uploads the working tree, so: commits not on the
 *   package-publish   upstream (else the remote default branch) PLUS every
 *                     uncommitted and untracked change.
 *   release           gh release create: commits since the previous tag.
 *                     gh pr merge: the current branch's pushed commits against
 *                     the remote default branch.
 *
 * Anything that cannot be worked out — not a git repository, git missing, a
 * dry run that failed, a PR named by number, a directory set at runtime — is
 * reported as UNKNOWN with its reason. It is never silently passed.
 */
import { createHash } from "node:crypto";
import type { PublishOperation } from "../publish-operation.js";
import type { ChangeSet, ChangeSetPart, RefUpdate } from "./change-set-types.js";
import { pushDryRun } from "./push-dry-run.js";
import {
  baseBeforeUnpushed, commitOf, commitsIn, currentBranch, diffBetween, emptyTree, mergeBase,
  pickRemote, previousTag, remoteDefaultRef, repoRootOf, untrackedFiles, upstreamOf,
} from "./git-queries.js";

type PartResult = ChangeSetPart | { reason: string };

export async function computeChangeSet(ops: PublishOperation[]): Promise<ChangeSet> {
  const parts: ChangeSetPart[] = [];
  const unknown: ChangeSet["unknown"] = [];
  const seen = new Set<string>();
  for (const op of ops) {
    const key = JSON.stringify([op.kind, op.cwd, op.pushArgs ?? [], op.explicitTarget ?? ""]);
    if (seen.has(key)) continue;
    seen.add(key);
    const result = await partFor(op);
    if ("reason" in result) unknown.push({ label: op.label, cwd: op.cwd, reason: result.reason });
    else parts.push(result);
  }
  const identity = [
    ...parts.map((p) => p.identity),
    ...unknown.map((u) => `unknown|${u.label}|${u.cwd}|${u.reason}`),
  ].join("\n--\n");
  return { parts, unknown, fingerprint: createHash("sha256").update(identity).digest("hex") };
}

async function partFor(op: PublishOperation): Promise<PartResult> {
  if (op.cwdUncertain) return { reason: "the command changes directory through a variable, so which repository it publishes from is only known at run time" };
  const repo = await repoRootOf(op.cwd);
  if ("reason" in repo) return repo;
  if (op.kind === "git-push") return pushPart(op, repo.root);
  if (op.kind === "release") return releasePart(op, repo.root);
  return workingTreePart(op, repo.root);
}

async function pushPart(op: PublishOperation, root: string): Promise<PartResult> {
  const dry = await pushDryRun(op.cwd, op.pushArgs ?? []);
  if (!dry.ok) return { reason: dry.reason };
  const remote = await pickRemote(root, op.pushArgs);
  const defaultRef = await remoteDefaultRef(root, remote);
  const refs: RefUpdate[] = [];
  const ranges = new Map<string, { base: string | null; head: string; baseLabel: string }>();
  for (const ref of dry.refs) {
    const newSha = ref.status === "deleted" ? undefined
      : (ref.localRef ? await commitOf(root, ref.localRef) : null) ?? (ref.newSha ? await commitOf(root, ref.newSha) : null) ?? undefined;
    const oldSha = ref.oldSha ? (await commitOf(root, ref.oldSha)) ?? ref.oldSha : undefined;
    refs.push({ ...ref, ...(oldSha ? { oldSha } : {}), ...(newSha ? { newSha } : {}) });
    if (!newSha || (ref.status !== "new" && ref.status !== "fast-forward" && ref.status !== "forced")) continue;
    let base: string | null = null;
    let baseLabel: string;
    if (ref.status === "fast-forward" && oldSha) {
      base = oldSha;
      baseLabel = `the remote's current ${ref.remoteRef}`;
    } else if (ref.status === "forced" && oldSha && await commitOf(root, oldSha)) {
      base = await mergeBase(root, oldSha, newSha);
      baseLabel = `the merge-base with the remote's current ${ref.remoteRef} (forced update)`;
    } else if (defaultRef) {
      base = await mergeBase(root, newSha, defaultRef);
      baseLabel = `the merge-base with ${defaultRef}`;
    } else {
      base = await baseBeforeUnpushed(root, newSha);
      baseLabel = "the parent of the oldest commit no remote has yet";
    }
    ranges.set(`${base ?? ""}..${newSha}`, { base, head: newSha, baseLabel });
  }
  const part: ChangeSetPart = {
    kind: op.kind, label: op.label, repoRoot: root, refs, baseLabel: "", commits: [], commitsTruncated: false,
    files: [], fileDiffs: [], diffTruncated: false, includesWorkingTree: false,
    identity: `push|${root}|${refs.map((r) => `${r.remoteRef} ${r.status} ${r.oldSha ?? ""} ${r.newSha ?? ""}`).sort().join(";")}`,
  };
  const empty = await emptyTree(root);
  const seenCommits = new Set<string>();
  const labels: string[] = [];
  for (const range of ranges.values()) {
    const log = await commitsIn(root, range.base ? [`${range.base}..${range.head}`] : [range.head, "--not", "--remotes"]);
    for (const c of log.commits) if (!seenCommits.has(c.sha)) { seenCommits.add(c.sha); part.commits.push(c); }
    part.commitsTruncated ||= log.truncated;
    const diff = await diffBetween(root, range.base ?? empty, range.head);
    part.files.push(...diff.files);
    part.fileDiffs.push(...diff.fileDiffs);
    part.diffTruncated ||= diff.truncated;
    labels.push(range.baseLabel);
  }
  part.baseLabel = [...new Set(labels)].join("; ");
  return part;
}

async function workingTreePart(op: PublishOperation, root: string): Promise<PartResult> {
  const head = await commitOf(root, "HEAD");
  const { base, baseLabel } = await compareBase(root, head);
  const empty = await emptyTree(root);
  const log = head ? await commitsIn(root, base ? [`${base}..${head}`] : [head, "--not", "--remotes"]) : { commits: [], truncated: false };
  const diff = await diffBetween(root, base ?? empty);
  const untracked = await untrackedFiles(root);
  return {
    kind: op.kind, label: op.label, repoRoot: root, baseLabel,
    commits: log.commits, commitsTruncated: log.truncated,
    files: [...diff.files, ...untracked.files],
    fileDiffs: [...diff.fileDiffs, ...untracked.fileDiffs],
    diffTruncated: diff.truncated,
    includesWorkingTree: true,
    identity: `tree|${root}|${head ?? "unborn"}|${base ?? "empty"}|${diff.sha256}|${untracked.identity}`,
  };
}

/** What a working-tree publish is compared against: the upstream, else the
 *  remote's default branch, else nothing (the whole tree ships as new). */
async function compareBase(root: string, head: string | null): Promise<{ base: string | null; baseLabel: string }> {
  const upstream = head ? await upstreamOf(root) : null;
  if (head && upstream) {
    const base = await mergeBase(root, head, upstream);
    if (base) return { base, baseLabel: `${upstream} (the branch's upstream)` };
  }
  const defaultRef = await remoteDefaultRef(root, await pickRemote(root));
  if (head && defaultRef) {
    const base = await mergeBase(root, head, defaultRef);
    if (base) return { base, baseLabel: `${defaultRef} (the remote's default branch)` };
  }
  return { base: null, baseLabel: "nothing — no upstream or remote default branch, so the whole tree is new" };
}

async function releasePart(op: PublishOperation, root: string): Promise<PartResult> {
  const isMerge = op.label.startsWith("gh pr merge");
  let head: string | null;
  let base: string | null = null;
  let baseLabel = "";
  if (isMerge) {
    const branch = await currentBranch(root);
    if (op.explicitTarget && op.explicitTarget !== branch) {
      return { reason: `gh pr merge ${op.explicitTarget} names a pull request whose commits are not the checked-out branch, so its diff is not in the local repository` };
    }
    // The PR holds what was PUSHED, not local commits the push never sent.
    head = (await commitOf(root, "@{u}")) ?? (await commitOf(root, "HEAD"));
    const defaultRef = await remoteDefaultRef(root, await pickRemote(root));
    if (head && defaultRef) { base = await mergeBase(root, head, defaultRef); baseLabel = `${defaultRef} (the branch it merges into)`; }
    if (!base) return { reason: "the remote's default branch is not known locally, so what the merge brings in cannot be computed" };
  } else {
    head = await commitOf(root, "HEAD");
    const tag = await previousTag(root, op.explicitTarget);
    if (tag) { base = await commitOf(root, tag); baseLabel = `${tag} (the previous release tag)`; }
    if (!base && head) {
      const defaultRef = await remoteDefaultRef(root, await pickRemote(root));
      if (defaultRef) { base = await mergeBase(root, head, defaultRef); baseLabel = `${defaultRef} (no earlier tag)`; }
    }
    if (!base) return { reason: "there is no earlier tag or remote default branch to say what this release adds" };
  }
  if (!head) return { reason: "the repository has no commits" };
  const log = await commitsIn(root, [`${base}..${head}`]);
  const diff = await diffBetween(root, base, head);
  return {
    kind: op.kind, label: op.label, repoRoot: root, baseLabel,
    commits: log.commits, commitsTruncated: log.truncated,
    files: diff.files, fileDiffs: diff.fileDiffs, diffTruncated: diff.truncated,
    includesWorkingTree: false,
    identity: `release|${root}|${op.label}|${base}..${head}`,
  };
}
