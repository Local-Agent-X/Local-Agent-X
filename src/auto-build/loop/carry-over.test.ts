// A chunk an earlier run set aside picks up its kept work and findings: each
// resume used to rebuild it from nothing, losing the last run's fixes
// (label-check's chunk 3: four runs, six branches, 2026-11-22). Real git repos.
import { afterAll, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { git } from "../../agency/worktree-core.js";
import { HARNESS_COMMIT_IDENTITY } from "../../git-safety.js";
import { clearSetAside, recordSetAside, setAsideRecordFor } from "../failure-recovery.js";
import { carryOverBrief, carryOverFor, mergeCarriedWork } from "./carry-over.js";

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
    clearSetAside(dir, 3);
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
    expect(brief).toContain("fix the class of input");
  });

  it("builds fresh, with the findings, when the kept work no longer merges", () => {
    const dir = project();
    writeFileSync(join(dir, "match.ts"), "export const rule = 'rewritten on main';\n");
    commit(dir, "main moved");
    recordSetAside(dir, 3, "autobuild/c3-6", "The skeptic broke it: `4 : 1`.");
    const wt = freshWorktree(dir, "c3-8");
    const merge = mergeCarriedWork(wt, "autobuild/c3-6");
    expect(merge.merged).toBe(false);
    expect(readFileSync(join(wt, "match.ts"), "utf8")).toContain("rewritten on main");
    expect(git(["status", "--porcelain"], wt)).toBe("");
    expect(carryOverBrief(carryOverFor(dir, 3)!, false)).toContain("you start fresh");
  });

  it("carries the findings alone when the kept branch is gone", () => {
    const dir = project();
    recordSetAside(dir, 3, "autobuild/c3-gone", "The skeptic broke it: `(root)` takes the name's place.");
    expect(carryOverFor(dir, 3)).toEqual({ findings: ["The skeptic broke it: `(root)` takes the name's place."] });
  });
});
