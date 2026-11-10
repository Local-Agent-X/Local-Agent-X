/**
 * What a merge overlaps (ADR 0007 §5), asked before the fast-forward:
 *
 *  1. **Both sides changed it.** Files this branch changed since it forked
 *     that the base also changed since then. Git merged them cleanly, which
 *     is exactly when nobody is told: the later change can quietly undo the
 *     earlier one's intent.
 *  2. **Live overlap.** Files this branch changed that another live agent
 *     claims (work-claims.ts).
 *
 * Neither blocks a merge git can do. The result is reported on the merge, a
 * `merged` hand-over note tells the other agents, and the agents panel shows
 * it. A failure to work any of this out reports nothing and never fails the
 * merge.
 */
import { join } from "node:path";
import { git } from "./worktree-core.js";
import { locateInRepo } from "./repo-locate.js";
import { liveHolders, type HolderView } from "./work-claims.js";
import { notesSince, postNote } from "./handover-notes.js";
import { normRepoPath, repoPathsOverlap } from "./path-overlap.js";
import { raiseToOrchestrator } from "./orchestrator-wake.js";

export interface MergeOverlap {
  path: string;
  /** Who else changed or is changing it. */
  with: string;
  why: "both-changed" | "live-claim";
}

export interface MergeFacts {
  repoRoot: string;
  worktreePath: string;
  branch: string;
  baseBranch: string;
  /** The base tip and the branch head before the base was merged in. */
  baseSha: string;
  headSha: string;
}

function lines(out: string): string[] {
  return out.split("\n").map((l) => l.trim()).filter(Boolean);
}

function sameDir(a: string, b: string): boolean {
  const n = (p: string) => p.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
  return n(a) === n(b);
}

/** The holder working in `worktreePath`, and the other live ones in its repo. */
function holdersAround(f: MergeFacts): { mine: HolderView | undefined; others: HolderView[]; repoKey: string | null } {
  const place = locateInRepo(join(f.worktreePath, ".merge"));
  if (!place) return { mine: undefined, others: [], repoKey: null };
  const all = liveHolders(place.repoKey);
  const mine = all.find((h) => sameDir(h.checkout, f.worktreePath));
  return { mine, others: all.filter((h) => h !== mine), repoKey: place.repoKey };
}

/** Who last said they merged a change to `path`, from the feed. */
function mergedBy(repoKey: string, path: string, notMe: string | undefined): string | null {
  const target = normRepoPath(path);
  const notes = notesSince(repoKey).filter((n) => n.kind === "merged" && n.sessionId !== notMe
    && n.paths.some((p) => normRepoPath(p) === target));
  return notes.length ? notes[notes.length - 1].displayName : null;
}

/** Overlaps of the branch's changes with the base's and with live agents'. */
export function findMergeOverlaps(f: MergeFacts): { changed: string[]; overlaps: MergeOverlap[] } {
  try {
    const fork = git(["merge-base", f.baseSha, f.headSha], f.worktreePath);
    const changed = lines(git(["diff", "--name-only", `${fork}..${f.headSha}`], f.worktreePath));
    const baseChanged = new Set(fork === f.baseSha ? [] : lines(git(["diff", "--name-only", `${fork}..${f.baseSha}`], f.worktreePath)));
    const { mine, others, repoKey } = holdersAround(f);
    const overlaps: MergeOverlap[] = [];
    for (const path of changed) {
      if (baseChanged.has(path)) {
        const who = repoKey ? mergedBy(repoKey, path, mine?.sessionId) : null;
        overlaps.push({ path, with: who ?? `another change on ${f.baseBranch}`, why: "both-changed" });
      }
      const target = normRepoPath(path);
      for (const h of others) {
        if (h.state === "recent") continue;
        if (h.claims.some((c) => repoPathsOverlap(normRepoPath(c.path), target))) overlaps.push({ path, with: h.displayName, why: "live-claim" });
      }
    }
    return { changed, overlaps };
  } catch {
    return { changed: [], overlaps: [] }; // unknown is reported as nothing, never as a failed merge
  }
}

/** One line for the merge's result, or "" when nothing overlaps. */
export function overlapSummary(overlaps: MergeOverlap[]): string {
  if (overlaps.length === 0) return "";
  const shown = overlaps.slice(0, 4).map((o) =>
    `${o.path} (${o.why === "both-changed" ? `also changed by ${o.with}` : `${o.with} is working on it`})`);
  const more = overlaps.length > shown.length ? `, +${overlaps.length - shown.length} more` : "";
  return `; overlaps other work: ${shown.join(", ")}${more}`;
}

/** Tell the other agents the branch landed, and what it overlapped. */
export function noteMerged(f: MergeFacts, changed: string[], overlaps: MergeOverlap[]): void {
  try {
    const { mine, repoKey } = holdersAround(f);
    if (!repoKey || changed.length === 0) return;
    postNote({
      sessionId: mine?.sessionId ?? `branch:${f.branch}`,
      displayName: mine?.displayName ?? f.branch,
      repoKey, paths: changed, kind: "merged",
      text: `Merged ${f.branch} into ${f.baseBranch}: ${changed.length} file(s)${mine?.task ? ` for "${mine.task}"` : ""}${overlapSummary(overlaps)}.`,
    });
    // A merge that landed on someone else's files is the orchestrator's to look at.
    if (overlaps.length > 0) {
      raiseToOrchestrator(repoKey, `merge|${f.branch}|${f.headSha}`,
        `"${mine?.displayName ?? f.branch}" merged ${f.branch} into ${f.baseBranch}${overlapSummary(overlaps)}.`);
    }
  } catch { /* the merge already happened; a note that could not be posted changes nothing */ }
}
