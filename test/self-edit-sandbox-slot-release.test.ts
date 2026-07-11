/**
 * AB-7 regression: a FAILED self_edit must release its in-memory worktree
 * registry slot while still preserving the branch + worktree dir on disk.
 *
 * Pre-fix, every gate-fail/held/crash path in runSelfEditInSandbox returned
 * without removing the activeWorktrees entry (only mergeWorktree's cleanup
 * path did). Slots count against MAX_CONCURRENT_WORKTREES, so after 12 failed
 * self_edits every subsequent self_edit AND applyGitUpdate was refused at the
 * cap — permanently, until restart.
 *
 * The surgeon + gates + global lock are mocked; the worktree lifecycle is REAL
 * (a temp git repo), so the test exercises the actual registry create/release.
 */

import { describe, it, expect, vi, afterAll } from "vitest";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

vi.mock("../src/self-edit/surgeon.js", () => ({
  runSurgeon: vi.fn(async () => ({})),
  formatSurgeonOutput: vi.fn(() => "surgeon output"),
}));

vi.mock("../src/self-edit/sandbox-gates.js", () => ({
  SKIPPED_GATE: { ok: false, skipped: true, durationMs: 0, detail: "skipped (earlier gate failed)" },
  gateDeps: vi.fn(() => ({ ok: false, skipped: false, durationMs: 5, detail: "simulated dep install failure" })),
  gateBuild: vi.fn(),
  gateBind: vi.fn(),
  gateSmoke: vi.fn(),
  killProbe: vi.fn(),
}));

vi.mock("../src/self-edit/global-lock.js", () => ({
  acquireGlobalSelfEditLock: vi.fn(() => ({ acquired: true })),
  releaseGlobalSelfEditLock: vi.fn(),
  formatGlobalLockBusy: vi.fn(() => "busy"),
  isSelfEditLockHeldByLiveProcess: vi.fn(() => false),
}));

vi.mock("../src/self-edit/parent-deps-guard.js", () => ({
  fingerprintParentDeps: vi.fn(() => "stable-fingerprint"),
  restoreParentDeps: vi.fn(() => ({ ok: true, detail: "" })),
}));

vi.mock("../src/self-edit/refute-merge.js", () => ({
  refuteSelfEditMerge: vi.fn(async () => ({ hold: false })),
}));

const { runSelfEditInSandbox } = await import("../src/self-edit/sandbox.js");
const { activeWorktrees, WORKTREE_BASE, worktreeSlotAvailable } = await import("../src/agency/worktree-core.js");

const repo = mkdtempSync(join(tmpdir(), "lax-slot-release-"));
const prevCwd = process.cwd();
const g = (args: string[]): string =>
  execFileSync("git", args, { cwd: repo, encoding: "utf-8", env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null" } }).trim();

afterAll(() => {
  process.chdir(prevCwd);
  // The preserved worktree dir has no junctions (the temp repo has no
  // node_modules to link), so a plain recursive delete is safe.
  for (const [name] of activeWorktrees) {
    if (name.startsWith("selfedit-")) {
      rmSync(join(WORKTREE_BASE, name), { recursive: true, force: true });
      activeWorktrees.delete(name);
    }
  }
  rmSync(repo, { recursive: true, force: true });
});

describe("failed self_edit releases its worktree registry slot (AB-7)", () => {
  it("gate-fail path frees the slot but preserves branch + worktree dir on disk", async () => {
    g(["init", "-q"]);
    g(["config", "user.email", "t@t"]);
    g(["config", "user.name", "t"]);
    writeFileSync(join(repo, "base.txt"), "base");
    g(["add", "-A"]);
    g(["commit", "-qm", "base"]);
    g(["branch", "-M", "main"]);

    // createNamedWorktree resolves the repo from process.cwd().
    process.chdir(repo);
    const registrySizeBefore = activeWorktrees.size;

    const res = await runSelfEditInSandbox({ task: "leak test", fullPrompt: "noop", authToken: "t" });

    expect(res.ok).toBe(false);
    expect(res.failure).toContain("Dependency install failed");

    // THE regression: the registry slot must be released on the fail path.
    // Pre-fix the selfedit-* entry leaked here and counted against the cap.
    const name = res.branchName.split("/").join("-");
    expect(activeWorktrees.has(name)).toBe(false);
    expect(activeWorktrees.size).toBe(registrySizeBefore);
    expect(worktreeSlotAvailable()).toBe(true);

    // Deliberate on-disk preservation is untouched: branch + worktree dir
    // survive for inspection (uncommitted surgeon changes live only there).
    expect(g(["branch", "--list", res.branchName])).toContain(res.branchName);
    const wtDir = join(WORKTREE_BASE, name);
    expect(existsSync(wtDir)).toBe(true);
    rmSync(wtDir, { recursive: true, force: true });
  });
});
