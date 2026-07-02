/**
 * ensureGitBaseline — the build loop's rollback machinery needs a git repo
 * with a HEAD, and nothing upstream guarantees one.
 *
 * Regression (Jul 2026 food-truck-tracker run): run_build_plan halted before
 * chunk 1 with "git rev-parse HEAD failed: not a git repository" because
 * finalize_app_build materializes plain files and no step ever ran git init.
 * The loop now establishes its own baseline instead of assuming it.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ensureGitBaseline, getHeadSha } from "../src/auto-build/git-helpers.js";

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf-8" });
}

describe("ensureGitBaseline", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "auto-build-baseline-"));
  });
  afterEach(() => {
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* win file locks */ }
  });

  it("inits a repo and commits everything when the dir is not a repo", async () => {
    writeFileSync(join(dir, "spec.md"), "# spec");
    const b = await ensureGitBaseline(dir);
    expect(b.initialized).toBe(true);
    expect(b.committed).toBe(true);
    expect(b.sha).toMatch(/^[0-9a-f]{40}$/);
    // Working tree is clean — spec.md is part of the baseline.
    expect(git(dir, "status", "--porcelain").trim()).toBe("");
    expect(await getHeadSha(dir)).toBe(b.sha);
  });

  it("commits a baseline in a fresh repo that has no HEAD yet", async () => {
    git(dir, "init");
    writeFileSync(join(dir, "a.txt"), "a");
    const b = await ensureGitBaseline(dir);
    expect(b.initialized).toBe(false);
    expect(b.committed).toBe(true);
    expect(b.sha).toMatch(/^[0-9a-f]{40}$/);
  });

  it("is a no-op when the repo already has a HEAD", async () => {
    git(dir, "init");
    git(dir, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "--allow-empty", "-m", "seed");
    const before = await getHeadSha(dir);
    const b = await ensureGitBaseline(dir);
    expect(b.initialized).toBe(false);
    expect(b.committed).toBe(false);
    expect(b.sha).toBe(before);
  });

  it("baselines an empty dir (allow-empty commit)", async () => {
    const b = await ensureGitBaseline(dir);
    expect(b.initialized).toBe(true);
    expect(b.committed).toBe(true);
    expect(b.sha).toMatch(/^[0-9a-f]{40}$/);
  });
});
