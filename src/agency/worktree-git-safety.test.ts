import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { composeGitArgs, GIT_SAFETY_ARGS, git, WORKTREE_BASE } from "./worktree-core.js";
import { bootSweepSafeForRepo, reapAppOwnWorktrees } from "./worktree-boot-sweep.js";
import { gitSafeCmd } from "../update-pipeline.js";

// ── Fixtures ────────────────────────────────────────────────────────────────
const roots: string[] = [];

const nullDevice = process.platform === "win32" ? "NUL" : "/dev/null";
function run(cwd: string, args: string[]): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf-8",
    env: { ...process.env, GIT_CONFIG_GLOBAL: nullDevice, GIT_CONFIG_SYSTEM: nullDevice },
  }).trim();
}

/** Init a real repo with one commit on main. */
function initRepo(): string {
  const root = mkdtempSync(join(tmpdir(), "lax-gitsafety-"));
  roots.push(root);
  const repo = join(root, "repo");
  mkdirSync(repo);
  run(repo, ["init", "-q"]);
  run(repo, ["config", "user.email", "gitsafety@test.invalid"]);
  run(repo, ["config", "user.name", "Git Safety Test"]);
  writeFileSync(join(repo, "base.txt"), "base\n");
  run(repo, ["add", "base.txt"]);
  run(repo, ["commit", "-q", "-m", "base"]);
  run(repo, ["branch", "-M", "main"]);
  return repo;
}

/** A directory NOT under WORKTREE_BASE — stands in for a user's sibling worktree. */
function foreignDir(): string {
  const root = mkdtempSync(join(tmpdir(), "lax-gitsafety-foreign-"));
  roots.push(root);
  return join(root, "wt");
}

function worktreeCount(repo: string): number {
  return run(repo, ["worktree", "list", "--porcelain"])
    .split("\n").filter(l => l.startsWith("worktree ")).length;
}

function norm(p: string): string {
  const real = realpathSync.native(p);
  return process.platform === "win32" ? real.toLowerCase() : real;
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

// ── Layer 3: every git invocation carries -c gc.auto=0 ───────────────────────
describe("git safety flags", () => {
  it("composeGitArgs prepends -c gc.auto=0 to array and string commands", () => {
    expect(GIT_SAFETY_ARGS).toEqual(["-c", "gc.auto=0"]);
    expect(composeGitArgs(["worktree", "prune"])).toEqual(["-c", "gc.auto=0", "worktree", "prune"]);
    expect(composeGitArgs("status --porcelain")).toEqual(["-c", "gc.auto=0", "status", "--porcelain"]);
  });

  it("git() actually runs with gc.auto disabled", () => {
    const repo = initRepo();
    // The repo never sets gc.auto, so a bare `git config --get gc.auto` would
    // exit 1 (throw). It returns "0" ONLY because git() injects -c gc.auto=0 for
    // the invocation — the belt-and-suspenders that stops auto-gc pruning a
    // shared object store. Fails before the fix (git ran without the flag).
    expect(git(["config", "--get", "gc.auto"], repo)).toBe("0");
  });
});

// ── Layer 1: git() never silently uses process.cwd() ─────────────────────────
describe("git() explicit cwd", () => {
  it("runs against the passed cwd, not process.cwd()", () => {
    const repo = initRepo();
    expect(norm(repo)).not.toBe(norm(process.cwd()));
    expect(norm(git(["rev-parse", "--show-toplevel"], repo))).toBe(norm(repo));
  });
});

// ── Layer 2: the boot sweep never mutates a user's live checkout ──────────────
describe("boot sweep repo scoping", () => {
  it("flags a checkout that hosts a worktree outside WORKTREE_BASE as unsafe", () => {
    const repo = initRepo();
    const foreign = foreignDir();
    run(repo, ["worktree", "add", "-q", "-b", "feature/x", foreign, "main"]);
    expect(bootSweepSafeForRepo(repo)).toBe(false);
  });

  it("treats a repo with only its main worktree as safe", () => {
    const repo = initRepo();
    expect(bootSweepSafeForRepo(repo)).toBe(true);
  });

  it("does NOT repo-global-prune a live dev checkout", () => {
    const repo = initRepo();
    const foreign = foreignDir();
    run(repo, ["worktree", "add", "-q", "-b", "feature/y", foreign, "main"]);
    // Delete the worktree dir so it is prunable — an unguarded `git worktree
    // prune` would de-register it. There are now 2 registrations (main + foreign).
    rmSync(foreign, { recursive: true, force: true });
    expect(worktreeCount(repo)).toBe(2);

    reapAppOwnWorktrees(repo);

    // The guard saw a worktree outside WORKTREE_BASE and skipped the prune —
    // the user's registration survives. Before the fix the prune ran and this
    // would drop to 1.
    expect(worktreeCount(repo)).toBe(2);
  });

  it("DOES prune the app's own orphan worktree under WORKTREE_BASE", () => {
    const repo = initRepo();
    mkdirSync(WORKTREE_BASE, { recursive: true });
    const own = join(WORKTREE_BASE, `gitsafety-own-${process.pid}-${Date.now()}`);
    run(repo, ["worktree", "add", "-q", "-b", "agent/own", own, "main"]);
    rmSync(own, { recursive: true, force: true }); // prunable orphan
    expect(worktreeCount(repo)).toBe(2);

    reapAppOwnWorktrees(repo);

    // Every linked worktree belongs to WORKTREE_BASE → safe → the app reaps its
    // own orphan registration.
    expect(worktreeCount(repo)).toBe(1);
    expect(existsSync(own)).toBe(false);
  });
});

// ── Layer 3: update pipeline git commands carry -c gc.auto=0 ──────────────────
describe("update-pipeline gitSafeCmd", () => {
  it("injects -c gc.auto=0 into fetch / merge / commit, leaves npm alone", () => {
    expect(gitSafeCmd("git fetch origin main --quiet")).toBe("git -c gc.auto=0 fetch origin main --quiet");
    expect(gitSafeCmd("git merge origin/main --no-edit")).toBe("git -c gc.auto=0 merge origin/main --no-edit");
    expect(gitSafeCmd("git commit -m msg")).toBe("git -c gc.auto=0 commit -m msg");
    expect(gitSafeCmd("git rev-parse HEAD")).toBe("git -c gc.auto=0 rev-parse HEAD");
    expect(gitSafeCmd("npm install")).toBe("npm install");
  });
});
