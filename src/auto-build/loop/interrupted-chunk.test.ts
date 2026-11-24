// A chunk a restart cut off resumes from the work its worker had written
// (label-check, 2026-11-23: "is there a way for it to save chunk 10's work").
// The boot sweep already kept a crashed worktree with work in it, for a caller
// with the same run id to claim; the chunk's run id was the orchestrator's op
// id, which every resume renews, so the resumed build never claimed it and the
// chunk started over. Real git repos, under the test run's own worktree base.
import { afterEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { activeWorktrees, git, pendingRecoveredWorktrees, WORKTREE_BASE } from "../../agency/worktree-core.js";
import { cleanupWorktree, createNamedWorktree } from "../../agency/worktree-lifecycle.js";
import { reconcileWorktreeBase } from "../../agency/worktree-recovery.js";
import { HARNESS_COMMIT_IDENTITY } from "../../git-safety.js";
import { INTERRUPTED_WORK_BRIEF, withInterruptedWork } from "./carry-over.js";
import { chunkWorktreeRunId } from "./parallel-waves.js";
import type { ParsedChunk } from "../plan-parser.js";

const dirs: string[] = [];
const names: string[] = [];
afterEach(() => {
  for (const name of names.splice(0)) cleanupWorktree(name);
  activeWorktrees.clear();
  pendingRecoveredWorktrees.clear();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function project(): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "lax-interrupted-")));
  dirs.push(dir);
  git(["init", "-q", "-b", "main"], dir);
  writeFileSync(join(dir, "app.ts"), "export const v = 1;\n");
  git(["add", "."], dir);
  git([...HARNESS_COMMIT_IDENTITY, "commit", "-q", "-m", "base"], dir);
  return dir;
}

describe("a chunk a restart cut off", () => {
  it("gets its kept worktree back, with the written work, in the next run of the same project", async () => {
    const dir = project();
    const name = `autobuild-c10-${Date.now()}`;
    names.push(name);
    const first = createNamedWorktree(name, "autobuild/c10", dir, chunkWorktreeRunId(dir, 10));
    expect(first).not.toBeNull();
    writeFileSync(join(first!.path, "matcher.ts"), "export const half = 'written';\n");

    // The process dies: nothing is in memory, and the sweep finds the owner dead.
    activeWorktrees.clear();
    await reconcileWorktreeBase(WORKTREE_BASE, () => false);
    expect(pendingRecoveredWorktrees.has(name)).toBe(true);

    const resumed = createNamedWorktree(name, "autobuild/c10", dir, chunkWorktreeRunId(dir, 10));
    expect(resumed).toMatchObject({ path: first!.path, branch: "autobuild/c10", recovered: true });
    expect(readFileSync(join(resumed!.path, "matcher.ts"), "utf8")).toContain("written");
  });

  it("is not handed to another project's build of the same chunk number", async () => {
    const dir = project();
    const other = project();
    const name = `autobuild-c4-${Date.now()}`;
    names.push(name);
    const first = createNamedWorktree(name, "autobuild/c4", dir, chunkWorktreeRunId(dir, 4));
    writeFileSync(join(first!.path, "work.ts"), "kept\n");
    activeWorktrees.clear();
    await reconcileWorktreeBase(WORKTREE_BASE, () => false);

    const claimed = createNamedWorktree(name, "autobuild/c4", other, chunkWorktreeRunId(other, 4));
    if (claimed) names.push(name);
    expect(claimed?.recovered).toBeUndefined();
    expect(existsSync(join(first!.path, "work.ts"))).toBe(true);
  });

  it("tells its worker the work is there to finish, ahead of anything a set-aside carries", () => {
    const emit = vi.fn();
    const chunk = { number: 10, title: "Results" } as ParsedChunk;
    const alone = withInterruptedWork(undefined, { chunk, totalChunks: 13, emit });
    expect(alone).toEqual({ brief: INTERRUPTED_WORK_BRIEF, findings: [] });
    expect(INTERRUPTED_WORK_BRIEF).toMatch(/do not start over/);
    expect(emit).toHaveBeenCalledWith(expect.objectContaining({ chunkNumber: 10, message: expect.stringMatching(/LAX restarted/) }));

    const both = withInterruptedWork({ brief: "An earlier run built this chunk and it was set aside.", findings: ["`4 : 1` comes back clean"] }, { chunk, totalChunks: 13, emit });
    expect(both.brief.startsWith(INTERRUPTED_WORK_BRIEF)).toBe(true);
    expect(both.brief).toContain("set aside");
    expect(both.findings).toEqual(["`4 : 1` comes back clean"]);
  });
});
