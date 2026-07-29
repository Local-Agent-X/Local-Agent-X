import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { git, gitAsync, GIT_OUTPUT_CAP, WORKTREE_BASE } from "./worktree-core.js";
import { bootSweepSafeForRepo, reapAppOwnWorktrees } from "./worktree-boot-sweep.js";
import { composeGitArgs, GIT_SAFETY_ARGS, gitSafeCmd } from "../git-safety.js";

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
  // Retry: the overflow test SIGKILLs a git child mid-stream, and Windows can
  // hold its handle on the repo dir for a beat after the process is gone.
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
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

// ── gitAsync: the non-blocking twin must be indistinguishable from git() ─────
describe("gitAsync", () => {
  it("returns the same value as git(), with the same safety flags", async () => {
    const repo = initRepo();
    expect(await gitAsync(["config", "--get", "gc.auto"], repo)).toBe("0");
    expect(await gitAsync(["rev-parse", "HEAD"], repo)).toBe(git(["rev-parse", "HEAD"], repo));
    expect(await gitAsync("rev-parse HEAD", repo)).toBe(git("rev-parse HEAD", repo));
  });

  it("runs against the passed cwd, not process.cwd()", async () => {
    const repo = initRepo();
    expect(norm(await gitAsync(["rev-parse", "--show-toplevel"], repo))).toBe(norm(repo));
  });

  it("decodes multi-byte output that straddles a pipe-chunk boundary", async () => {
    const repo = initRepo();
    // A 3-byte character repeated: a 64 KiB pipe read ends at byte 65536, and
    // 65536 % 3 === 1, so the FIRST chunk boundary lands mid-character. Decoding
    // each Buffer independently (`stdout += chunk`) turns that character into
    // U+FFFD and every byte offset after it shifts — silent corruption of data
    // getMergeDeltaDiff/getMergeDeltaFiles then PARSE. git() decodes the whole
    // buffer at once and is correct; the async twin must match it exactly.
    const text = "漢".repeat(200_000); // ~600 KB, well under git()'s 1 MiB maxBuffer
    writeFileSync(join(repo, "wide.txt"), text);
    run(repo, ["add", "wide.txt"]);
    run(repo, ["commit", "-q", "-m", "wide"]);

    const viaAsync = await gitAsync(["show", "HEAD:wide.txt"], repo);
    expect(viaAsync).not.toContain("�");
    expect(viaAsync.length).toBe(text.length);
    expect(viaAsync).toBe(git(["show", "HEAD:wide.txt"], repo));
  }, 60_000);

  it("rejects instead of buffering without bound when output blows the cap", async () => {
    const repo = initRepo();
    // Sync git() is capped by execFileSync's 1 MiB maxBuffer — it throws
    // ENOBUFS rather than growing forever. The async twin must stay bounded
    // too: getMergeDeltaDiff can ask for a multi-MB diff, and an unbounded
    // accumulator is a memory risk on exactly that call. Over the cap must be
    // an ERROR, never a silent truncation, because callers parse this output.
    writeFileSync(join(repo, "huge.bin"), "a".repeat(GIT_OUTPUT_CAP + 1024 * 1024));
    run(repo, ["add", "huge.bin"]);
    run(repo, ["commit", "-q", "-m", "huge"]);
    await expect(gitAsync(["show", "HEAD:huge.bin"], repo)).rejects.toThrow(/exceeded .* cap/);
  }, 120_000);

  it("rejects with the same `git <cmd> failed: <stderr>` shape as git()", async () => {
    const repo = initRepo();
    const bad = ["rev-parse", "--verify", "no-such-ref"];
    let syncMessage = "";
    try { git(bad, repo); } catch (e) { syncMessage = (e as Error).message; }
    expect(syncMessage).toMatch(/^git rev-parse --verify no-such-ref failed: /);
    await expect(gitAsync(bad, repo)).rejects.toThrow(/^git rev-parse --verify no-such-ref failed: /);
  });

  it("lets the loop breathe across back-to-back calls; git() does not", async () => {
    const repo = initRepo();
    // The shape every worktree op has: several git invocations in a row with
    // nothing between them. Synchronously that is dead air for their sum.
    const ticksDuring = async (run: () => unknown): Promise<number> => {
      let ticks = 0;
      const timer = setInterval(() => { ticks++; }, 5);
      try { await run(); } finally { clearInterval(timer); }
      return ticks;
    };
    const asyncTicks = await ticksDuring(async () => {
      for (let i = 0; i < 6; i++) await gitAsync(["rev-parse", "HEAD"], repo);
    });
    const syncTicks = await ticksDuring(() => {
      for (let i = 0; i < 6; i++) git(["rev-parse", "HEAD"], repo);
    });
    expect(asyncTicks).toBeGreaterThan(0);
    expect(syncTicks).toBe(0);
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
