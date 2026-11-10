import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Op } from "../ops/types.js";
import { findMergeOverlaps, noteMerged, overlapSummary, type MergeFacts } from "./merge-overlap.js";
import { recordClaims, _resetWorkClaimsForTest, _setWorkClaimsForTest } from "./work-claims.js";
import { notesSince, _resetHandoverNotesForTest, _setHandoverNotesForTest } from "./handover-notes.js";
import { locateInRepo, _resetRepoLocateCacheForTest } from "./repo-locate.js";

let repo: string;
let wt: string;
const g = (cwd: string, ...args: string[]) =>
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", ...args], { cwd, encoding: "utf8" }).trim();

function commit(cwd: string, file: string, body: string, msg: string): void {
  writeFileSync(join(cwd, file), body);
  g(cwd, "add", "-A");
  g(cwd, "commit", "-q", "-m", msg);
}

function facts(): MergeFacts {
  return { repoRoot: repo, worktreePath: wt, branch: "agent/a1", baseBranch: "main", baseSha: g(repo, "rev-parse", "main"), headSha: g(wt, "rev-parse", "HEAD") };
}

beforeEach(() => {
  const root = mkdtempSync(join(tmpdir(), "lax-merge-"));
  repo = join(root, "repo");
  wt = join(root, "wt");
  execFileSync("git", ["init", "-q", "-b", "main", repo]);
  commit(repo, "shared.ts", "a\nb\nc\nd\ne\nf\ng\nh\n", "base");
  commit(repo, "solo.ts", "one\n", "solo");
  g(repo, "worktree", "add", "-q", "-b", "agent/a1", wt);
  _resetRepoLocateCacheForTest();
  _setWorkClaimsForTest({ dir: join(root, "holders"), readOp: (id) => ({ id, lane: "interactive", status: "running", task: "tune shared", canonical: { leaseExpiresAt: new Date(Date.now() + 60_000).toISOString() } }) as unknown as Op });
  _setHandoverNotesForTest({ dir: join(root, "notes") });
});
afterEach(() => { _resetWorkClaimsForTest(); _resetHandoverNotesForTest(); });

describe("what a merge overlaps", () => {
  it("names a file both sides changed even though git merges it cleanly", () => {
    commit(wt, "shared.ts", "A\nb\nc\nd\ne\nf\ng\nh\n", "branch edits the top");
    commit(repo, "shared.ts", "a\nb\nc\nd\ne\nf\ng\nH\n", "main edits the bottom");
    const { changed, overlaps } = findMergeOverlaps(facts());
    expect(changed).toEqual(["shared.ts"]);
    expect(overlaps).toEqual([{ path: "shared.ts", with: "another change on main", why: "both-changed" }]);
    expect(overlapSummary(overlaps)).toBe("; overlaps other work: shared.ts (also changed by another change on main)");
    // git really does merge it without a conflict.
    expect(() => g(wt, "merge", "-q", "--no-edit", "main")).not.toThrow();
  });

  it("names a live agent that claims a file the branch changed", () => {
    commit(wt, "solo.ts", "two\n", "branch edits solo");
    recordClaims({ sessionId: "chat-b", opId: "op-b", paths: [join(repo, "solo.ts")], source: "written", displayName: "Tuning chat" });
    expect(findMergeOverlaps(facts()).overlaps).toEqual([{ path: "solo.ts", with: "Tuning chat", why: "live-claim" }]);
  });

  it("reports nothing when the branch's files are its own", () => {
    commit(wt, "new.ts", "x\n", "branch adds a file");
    commit(repo, "solo.ts", "three\n", "main edits something else");
    expect(findMergeOverlaps(facts())).toEqual({ changed: ["new.ts"], overlaps: [] });
    expect(overlapSummary([])).toBe("");
  });

  it("posts a merged note the other agents read, naming the overlap", () => {
    commit(wt, "solo.ts", "two\n", "branch edits solo");
    recordClaims({ sessionId: "chat-b", opId: "op-b", paths: [join(repo, "solo.ts")], source: "written", displayName: "Tuning chat" });
    const f = facts();
    const { changed, overlaps } = findMergeOverlaps(f);
    noteMerged(f, changed, overlaps);
    const notes = notesSince(locateInRepo(join(repo, "x"))!.repoKey);
    expect(notes).toHaveLength(1);
    expect(notes[0]).toMatchObject({ kind: "merged", paths: ["solo.ts"], displayName: "agent/a1" });
    expect(notes[0].text).toContain("Merged agent/a1 into main: 1 file(s); overlaps other work: solo.ts (Tuning chat is working on it)");
  });
});
