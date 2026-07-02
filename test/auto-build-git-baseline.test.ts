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
import { mkdtempSync, rmSync, writeFileSync, readFileSync, mkdirSync, existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ensureGitBaseline, getHeadSha, gitFailText } from "../src/auto-build/git-helpers.js";
import { makeInitial, markHalted } from "../src/auto-build/orchestrator/state.js";

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

// Regression (2026-07-02 chunk-1 commit): no ignore rules → `git add .`
// swept node_modules/ + .next/ and hit the 30s timeout, and the halt reason
// was 3.6MB of CRLF warnings. The baseline must install ignore rules and
// git failures must read as messages.
describe("baseline ignore rules + failure text", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "auto-build-excludes-"));
  });
  afterEach(() => {
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* win file locks */ }
  });

  it("fresh init writes a starter .gitignore and loop excludes", async () => {
    await ensureGitBaseline(dir);
    const gi = readFileSync(join(dir, ".gitignore"), "utf-8");
    expect(gi).toContain("node_modules/");
    expect(gi).toContain(".lax-build-run.json");
    const ex = readFileSync(join(dir, ".git", "info", "exclude"), "utf-8");
    expect(ex).toContain("# lax-auto-build excludes");
  });

  it("pre-existing repo without .gitignore still gets info/exclude rules (idempotent)", async () => {
    git(dir, "init");
    git(dir, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "--allow-empty", "-m", "seed");
    await ensureGitBaseline(dir);
    await ensureGitBaseline(dir); // second run must not duplicate the block
    const ex = readFileSync(join(dir, ".git", "info", "exclude"), "utf-8");
    expect([...ex.matchAll(/# lax-auto-build excludes/g)]).toHaveLength(1);
    // No starter .gitignore imposed on an existing repo.
    expect(existsSync(join(dir, ".gitignore"))).toBe(false);
    // And the excludes actually bite: junk created later stays untracked-invisible.
    mkdirSync(join(dir, "node_modules", "pkg"), { recursive: true });
    writeFileSync(join(dir, "node_modules", "pkg", "index.js"), "x");
    writeFileSync(join(dir, ".lax-build-run.json"), "{}");
    expect(git(dir, "status", "--porcelain").trim()).toBe("");
  });

  it("gitFailText: timeout reads as timeout, warnings are filtered and capped", () => {
    expect(gitFailText("git add .", { exitCode: null, stdout: "", stderr: "warning: spam\n".repeat(50), timedOut: true }, 180000))
      .toContain("timed out after 180s");
    const spam = Array.from({ length: 5000 }, (_, i) => `warning: in the working copy of 'f${i}.js', LF will be replaced`).join("\n");
    const msg = gitFailText("git add .", { exitCode: 1, stdout: "", stderr: spam + "\nfatal: real problem", timedOut: false });
    expect(msg).toContain("fatal: real problem");
    expect(msg).not.toContain("warning:");
    expect(msg.length).toBeLessThan(2000);
  });
});

// Companion backstop: the halt reason is rewritten to disk on every event
// and broadcast to chat — it must stay a message even if a caller hands it
// a stderr dump.
describe("markHalted caps the persisted halt reason", () => {
  it("truncates megabyte reasons to ~4KB", () => {
    const s = makeInitial({ opId: "op_x", sessionId: "s", projectDir: "/p", planPath: "/p/spec/plan.md", totalChunks: 3, startingChunk: 1 });
    const halted = markHalted(s, 1, "loop-halt", "w".repeat(4_000_000));
    expect(halted.haltReason.length).toBeLessThan(4100);
    expect(halted.haltReason).toContain("[truncated]");
  });
});
