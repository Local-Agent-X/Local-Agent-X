/**
 * Anti-mock-theater integration test for the S3 parallel path (Finding 1).
 *
 * The mocked orchestration test stubs createNamedWorktree, so it CANNOT catch
 * the real ship-blocker: createNamedWorktree derived its repo root from
 * process.cwd(). The auto-build loop runs inside the long-lived LAX server
 * (cwd = the LAX repo), but the parallel path builds the USER's app in a
 * DIFFERENT repo (opts.projectDir). A cwd-derived root would cut worktrees from
 * LAX's own repo — corrupting LAX and shipping the user an empty app.
 *
 * This test uses the REAL worktree lib (NO mocks): it stands up two throwaway
 * git repos — a "trap" repo it chdir's into (simulating the LAX server's cwd)
 * and the "project" repo — then drives createNamedWorktree(name, branch,
 * projectRepo) + commitInWorktree + mergeWorktree and asserts every artifact
 * lands in the PROJECT repo while the trap (cwd) repo stays untouched.
 *
 * Pre-fix (repoRoot ignored / cwd used) this FAILS: the branch + commit land in
 * the trap repo, so the project-repo assertions fail.
 */

import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";

import { createNamedWorktree, commitInWorktree, mergeWorktree, cleanupWorktree } from "../src/agency/worktree.js";

function g(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf-8" }).trim();
}

function makeRepo(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  g(dir, "init", "-q", "-b", "main");
  g(dir, "config", "user.email", "t@e.co");
  g(dir, "config", "user.name", "T");
  writeFileSync(join(dir, "seed.txt"), "seed\n");
  g(dir, "add", "-A");
  g(dir, "commit", "-qm", "seed");
  return dir;
}

let cleanups: Array<() => void> = [];
afterEach(() => {
  for (const c of cleanups.splice(0)) { try { c(); } catch { /* best-effort */ } }
});

describe("createNamedWorktree(repoRoot) — worktrees are cut from the PROJECT repo, not cwd", () => {
  it("branch + commit + merge land in the project repo while cwd's repo stays untouched", () => {
    const origCwd = process.cwd();
    const trapRepo = makeRepo("wt-trap-");      // stands in for the LAX server's cwd
    const projectRepo = makeRepo("wt-project-"); // the user's app repo
    const suffix = Math.random().toString(36).slice(2, 8);
    const name = `itest-${suffix}`;
    const branch = `autobuild/itest-${suffix}`;

    cleanups.push(() => process.chdir(origCwd));
    cleanups.push(() => { try { cleanupWorktree(name); } catch { /* */ } });
    cleanups.push(() => rmSync(trapRepo, { recursive: true, force: true }));
    cleanups.push(() => rmSync(projectRepo, { recursive: true, force: true }));

    const trapHeadBefore = g(trapRepo, "rev-parse", "HEAD");
    const projectHeadBefore = g(projectRepo, "rev-parse", "HEAD");

    // Simulate the production trap: process.cwd() is the WRONG (LAX) repo.
    process.chdir(trapRepo);

    const wt = createNamedWorktree(name, branch, projectRepo);
    expect(wt).not.toBeNull();

    // The branch was cut from the PROJECT repo — NOT the cwd/trap repo.
    expect(g(projectRepo, "branch", "--list", branch)).toContain(branch);
    expect(g(trapRepo, "branch", "--list", branch)).toBe(""); // trap has no such branch

    // Do real work in the worktree and merge it back.
    writeFileSync(join(wt!.path, "app.txt"), "hello from the user app\n");
    const sha = commitInWorktree(name, "chunk 1: add app.txt");
    expect(sha).toBeTruthy();

    const merge = mergeWorktree(name);
    expect(merge.merged).toBe(true);

    // The merge advanced the PROJECT repo's base branch + landed the file there.
    expect(g(projectRepo, "rev-parse", "HEAD")).not.toBe(projectHeadBefore);
    expect(existsSync(join(projectRepo, "app.txt"))).toBe(true);

    // The cwd/trap repo is completely untouched: same HEAD, no app.txt.
    expect(g(trapRepo, "rev-parse", "HEAD")).toBe(trapHeadBefore);
    expect(existsSync(join(trapRepo, "app.txt"))).toBe(false);
  });
});
