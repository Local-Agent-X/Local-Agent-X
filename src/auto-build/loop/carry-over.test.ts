// A chunk an earlier run set aside picks up its kept work and findings: each
// resume used to rebuild it from nothing, losing the last run's fixes
// (label-check's chunk 3: four runs, six branches, 2026-11-22). Real git repos.
import { FIX_THE_CLASS } from "../chunk-review/skeptic-bar.js";
import { afterAll, describe, expect, it } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { git } from "../../agency/worktree-core.js";
import { HARNESS_COMMIT_IDENTITY } from "../../git-safety.js";
import { recordLanded, recordSetAside, setAsideRecordFor } from "../failure-recovery.js";
import { carryOverBrief, carryOverFor, landedUnrecorded, mergeCarriedWork } from "./carry-over.js";
import { gateConflictMarkers } from "../chunk-review/conflict-markers.js";

const dirs: string[] = [];
afterAll(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });

const commit = (cwd: string, msg: string) => git([...HARNESS_COMMIT_IDENTITY, "commit", "-q", "-am", msg], cwd);

/** A project on main with a matcher file, and a kept branch that changed it. */
function project(): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "lax-carry-")));
  dirs.push(dir);
  git(["init", "-q", "-b", "main"], dir);
  writeFileSync(join(dir, "match.ts"), "export const rule = 'v1';\n");
  git(["add", "."], dir);
  git([...HARNESS_COMMIT_IDENTITY, "commit", "-q", "-m", "base"], dir);
  git(["checkout", "-q", "-b", "autobuild/c3-6"], dir);
  writeFileSync(join(dir, "match.ts"), "export const rule = 'v1 + ratio spacing fix';\n");
  commit(dir, "chunk 3 (preserved on halt): Matching");
  git(["checkout", "-q", "main"], dir);
  return dir;
}

/** The fresh branch and worktree a new run cuts for the chunk. */
function freshWorktree(dir: string, name: string): string {
  const wt = join(dir, "..", `${name}-${Date.now()}`);
  dirs.push(wt);
  git(["worktree", "add", "-q", "-b", `autobuild/${name}`, wt, "main"], dir);
  return wt;
}

describe("carry-over of a set-aside chunk", () => {
  it("records the branch and findings, keeps the branch when a later run wrote nothing, and clears on landing", () => {
    const dir = project();
    recordSetAside(dir, 3, "autobuild/c3-6", "The skeptic broke it: `4 : 1` with spaces comes back clean.");
    recordSetAside(dir, 3, undefined, "The skeptic broke it: `0.3 %` with a space before the % finds nothing.");
    recordSetAside(dir, 3, undefined, "The skeptic broke it: `0.3 %` with a space before the % finds nothing.");
    expect(setAsideRecordFor(dir, 3)).toEqual({
      branch: "autobuild/c3-6",
      findings: [
        "The skeptic broke it: `4 : 1` with spaces comes back clean.",
        "The skeptic broke it: `0.3 %` with a space before the % finds nothing.",
      ],
    });
    // The halt history the file also holds is untouched by the record, and vice versa.
    expect(JSON.parse(readFileSync(join(dir, ".lax-build-history.json"), "utf8")).haltHistory).toEqual([]);
    recordLanded(dir, 3);
    expect(setAsideRecordFor(dir, 3)).toBeUndefined();
    expect(carryOverFor(dir, 3)).toBeNull();
  });

  it("merges the kept work into the new run's worktree, so the worker starts from it", () => {
    const dir = project();
    recordSetAside(dir, 3, "autobuild/c3-6", "The skeptic broke it: `4 : 1`.");
    const carry = carryOverFor(dir, 3)!;
    expect(carry.branch).toBe("autobuild/c3-6");
    const wt = freshWorktree(dir, "c3-7");
    expect(mergeCarriedWork(wt, carry.branch!).merged).toBe(true);
    expect(readFileSync(join(wt, "match.ts"), "utf8")).toContain("ratio spacing fix");

    const brief = carryOverBrief(carry, true);
    expect(brief).toContain("already merged into your tree");
    expect(brief).toContain("`4 : 1`");
    expect(brief).toContain(FIX_THE_CLASS);
  });

  // This used to abort the merge and build the chunk from nothing ("you start
  // fresh"). A chunk set aside BECAUSE it conflicted with a sibling was then
  // built a second time on every resume: three reviewed chunks of one build in
  // a day (label-check-grok, 2026-11-26). The work is in the tree, with the
  // conflict for the worker to combine.
  it("when the kept work conflicts with what landed since, both sides are left in the tree for the worker to combine", () => {
    const dir = project();
    writeFileSync(join(dir, "match.ts"), "export const rule = 'rewritten on main';\n");
    commit(dir, "main moved");
    recordSetAside(dir, 3, "autobuild/c3-6", "The skeptic broke it: `4 : 1`.");
    const wt = freshWorktree(dir, "c3-8");
    const merge = mergeCarriedWork(wt, "autobuild/c3-6");
    expect(merge.merged).toBe(false);
    expect(merge.conflicted).toEqual(["match.ts"]);
    const text = readFileSync(join(wt, "match.ts"), "utf8");
    expect(text).toContain("rewritten on main");
    expect(text).toContain("ratio spacing fix");
    expect(git(["status", "--porcelain"], wt)).toBe("UU match.ts");
    // Until the worker has combined them, the review sends the chunk back.
    expect(gateConflictMarkers(wt, ["match.ts"])).toMatchObject({ gate: "worktree-merge", action: "push_back" });

    const brief = carryOverBrief(carryOverFor(dir, 3)!, false, merge.conflicted);
    expect(brief).toContain("stopped on conflicts in: match.ts");
    expect(brief).toContain("Do not abort the merge");
    expect(brief).not.toContain("you start fresh");
    expect(brief).toContain("`4 : 1`");

    // Combined and committed, the merge is concluded and the markers are gone.
    writeFileSync(join(wt, "match.ts"), "export const rule = 'rewritten on main'; // ratio spacing fix\n");
    expect(gateConflictMarkers(wt, ["match.ts"])).toBeNull();
    commit(wt, "chunk 3: combined");
    expect(git(["status", "--porcelain"], wt)).toBe("");
    expect(git(["log", "-1", "--format=%P"], wt).split(" ")).toHaveLength(2);
  });

  it("a kept branch that fails to merge for another reason is dropped and the chunk starts fresh", () => {
    const dir = project();
    recordSetAside(dir, 3, "autobuild/c3-6", "The skeptic broke it: `4 : 1`.");
    const wt = freshWorktree(dir, "c3-9");
    const merge = mergeCarriedWork(wt, "autobuild/no-such-branch");
    expect(merge.merged).toBe(false);
    expect(merge.conflicted).toBeUndefined();
    expect(git(["status", "--porcelain"], wt)).toBe("");
    expect(carryOverBrief(carryOverFor(dir, 3)!, false)).toContain("you start fresh");
  });

  it("carries the findings alone when the kept branch is gone", () => {
    const dir = project();
    recordSetAside(dir, 3, "autobuild/c3-gone", "The skeptic broke it: `(root)` takes the name's place.");
    expect(carryOverFor(dir, 3)).toEqual({ findings: ["The skeptic broke it: `(root)` takes the name's place."] });
  });

  // A chunk the owner paused mid-build goes on from the round it was on, and
  // its worker is told it was paused, not set aside (orchestrator/run-control.ts).
  it("a paused chunk carries its round, and its brief says it was paused", () => {
    const dir = project();
    recordSetAside(dir, 3, "autobuild/c3-6", ["cancel loses data", "test passes without the fix"], 4);
    const carry = carryOverFor(dir, 3)!;
    expect(carry).toEqual({ branch: "autobuild/c3-6", findings: ["cancel loses data", "test passes without the fix"], round: 4 });
    expect(carryOverBrief(carry, true)).toMatch(/^The build was paused while this chunk was building \(fix round 4\)/);
    // Set aside after that, it gets a full budget again: no round on the record.
    recordSetAside(dir, 3, undefined, "out of rounds");
    expect(carryOverFor(dir, 3)?.round).toBeUndefined();
  });
});

// A kill after a chunk's branch merged and before the run recorded it: the
// resume used to build the chunk again on a project that already had it.
describe("landedUnrecorded", () => {
  const land = (dir: string, branch: string, subject: string) => {
    git(["checkout", "-q", "-b", branch], dir);
    writeFileSync(join(dir, `${branch.replace(/\W/g, "-")}.ts`), "export {};\n");
    git(["add", "."], dir);
    git([...HARNESS_COMMIT_IDENTITY, "commit", "-q", "-m", subject], dir);
    git(["checkout", "-q", "main"], dir);
    git(["merge", "-q", "--ff-only", branch], dir);
  };
  const longAgo = "2020-01-01T00:00:00.000Z";

  it("finds a chunk whose branch is merged and ends in its own landing commit", () => {
    const dir = project();
    land(dir, "autobuild/c2", "chunk 2: List");
    land(dir, "autobuild/c4-2", "chunk 4: Detail");
    expect(landedUnrecorded(dir, [1, 2, 3, 4], longAgo)).toEqual([2, 4]);
  });

  it("does not count kept work, an unmerged branch, or a leftover from before this run", () => {
    const dir = project();
    // autobuild/c3-6 is unmerged kept work (project()).
    land(dir, "autobuild/c5", "chunk 5 (preserved on halt): Scan");
    land(dir, "autobuild/c2", "chunk 2: List");
    expect(landedUnrecorded(dir, [2, 3, 5], longAgo)).toEqual([2]);
    expect(landedUnrecorded(dir, [2], new Date(Date.now() + 60_000).toISOString())).toEqual([]);
  });
});

// Finish fix 1011, label-check-grok, 2026-11-27: on resume its kept branch
// would not merge, because files that branch adds sat untracked in the tree
// (its own earlier attempt's), and the fix was rebuilt from nothing.
describe("carry-over over files the chunk's earlier attempt left untracked", () => {
  function withAddedFiles(): string {
    const dir = project();
    git(["checkout", "-q", "autobuild/c3-6"], dir);
    mkdirSync(join(dir, "src", "meds"), { recursive: true });
    writeFileSync(join(dir, "src", "meds", "realm-add.ts"), "export const add = 2;\n");
    writeFileSync(join(dir, "src", "meds", "probe.ts"), "export const probe = 'kept';\n");
    git(["add", "."], dir);
    git([...HARNESS_COMMIT_IDENTITY, "commit", "-q", "-m", "chunk 3: added files"], dir);
    git(["checkout", "-q", "main"], dir);
    return dir;
  }

  it("takes the kept work: identical leftovers are dropped, a differing one is saved inside .git, and nothing is rebuilt", () => {
    const dir = withAddedFiles();
    const wt = freshWorktree(dir, "c3-10");
    mkdirSync(join(wt, "src", "meds"), { recursive: true });
    writeFileSync(join(wt, "src", "meds", "realm-add.ts"), "export const add = 2;\n");
    writeFileSync(join(wt, "src", "meds", "probe.ts"), "export const probe = 'half-written';\n");

    const merge = mergeCarriedWork(wt, "autobuild/c3-6");
    expect(merge.merged).toBe(true);
    expect(merge.displaced?.sort()).toEqual(["src/meds/probe.ts", "src/meds/realm-add.ts"]);
    expect(readFileSync(join(wt, "src", "meds", "probe.ts"), "utf8").trimEnd()).toBe("export const probe = 'kept';");
    expect(readFileSync(join(wt, "match.ts"), "utf8")).toContain("ratio spacing fix");
    expect(git(["status", "--porcelain"], wt)).toBe("");

    const gitDir = git(["rev-parse", "--absolute-git-dir"], wt);
    const saved = readdirSync(join(gitDir, "lax-displaced"));
    expect(saved).toHaveLength(1);
    expect(readFileSync(join(gitDir, "lax-displaced", saved[0], "src", "meds", "probe.ts"), "utf8")).toContain("half-written");
    expect(existsSync(join(gitDir, "lax-displaced", saved[0], "src", "meds", "realm-add.ts"))).toBe(false);
  });

  it("an untracked file the branch does not have is left as it was", () => {
    const dir = withAddedFiles();
    const wt = freshWorktree(dir, "c3-11");
    writeFileSync(join(wt, "notes.txt"), "mine");
    expect(mergeCarriedWork(wt, "autobuild/c3-6").merged).toBe(true);
    expect(readFileSync(join(wt, "notes.txt"), "utf8")).toBe("mine");
  });
});
