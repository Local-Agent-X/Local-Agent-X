import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  activeWorktrees, MAX_CONCURRENT_WORKTREES, MAX_PENDING_RECOVERED_WORKTREES,
  pendingRecoveredWorktrees, type WorktreeEntry,
} from "./worktree-core.js";
import { cleanupAllWorktrees, cleanupWorktree, createNamedWorktree } from "./worktree-lifecycle.js";
import {
  ownsWorktree,
  claimRecoveredWorktree,
  reconcileWorktreeBase,
  registerWorktreeOwnership,
  worktreeOwnershipRecordPath,
} from "./worktree-recovery.js";
import { currentProcessIncarnation } from "./worktree-process.js";

interface Fixture {
  repo: string;
  base: string;
  name: string;
  path: string;
  branch: string;
  entry: WorktreeEntry;
}

const fixtures: Fixture[] = [];
const extraRoots: string[] = [];

const CAN_CREATE_DIR_LINK = (() => {
  const root = mkdtempSync(join(tmpdir(), "lax-wt-link-probe-"));
  try {
    const target = join(root, "target");
    mkdirSync(target);
    symlinkSync(target, join(root, "link"), process.platform === "win32" ? "junction" : "dir");
    return true;
  } catch {
    return false;
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
})();

function run(cwd: string, args: string[]): string {
  const nullDevice = process.platform === "win32" ? "NUL" : "/dev/null";
  return execFileSync("git", args, {
    cwd,
    encoding: "utf-8",
    env: { ...process.env, GIT_CONFIG_GLOBAL: nullDevice, GIT_CONFIG_SYSTEM: nullDevice },
  }).trim();
}

function fixture(name: string, register = true, runId = name): Fixture {
  const root = mkdtempSync(join(tmpdir(), "lax-wt-recovery-"));
  const repo = join(root, "repo");
  const base = join(root, "worktrees");
  run(root, ["init", repo]);
  run(repo, ["config", "user.email", "recovery@test.invalid"]);
  run(repo, ["config", "user.name", "Recovery Test"]);
  writeFileSync(join(repo, "base.txt"), "base\n");
  run(repo, ["add", "base.txt"]);
  run(repo, ["commit", "-m", "base"]);
  run(repo, ["branch", "-M", "main"]);
  const path = join(base, name);
  const branch = `agent/${name}`;
  run(repo, ["worktree", "add", "-b", branch, path, "main"]);
  let entry: WorktreeEntry = {
    path,
    branch,
    baseBranch: "main",
    repoRoot: repo,
    mergedSuccessfully: false,
  };
  if (register) entry = registerWorktreeOwnership(name, entry, runId);
  const value = { repo, base, name, path, branch, entry };
  fixtures.push(value);
  return value;
}

afterEach(() => {
  activeWorktrees.clear();
  pendingRecoveredWorktrees.clear();
  for (const f of fixtures.splice(0)) {
    try { run(f.repo, ["worktree", "remove", f.path, "--force"]); } catch { /* gone */ }
    rmSync(join(f.repo, ".."), { recursive: true, force: true });
  }
  for (const root of extraRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("durable worktree recovery", () => {
  it("leaves a worktree owned by a live process untouched", async () => {
    const f = fixture("live");
    const result = await reconcileWorktreeBase(f.base, pid => pid === process.pid);

    expect(result).toEqual([expect.objectContaining({ disposition: "live" })]);
    expect(existsSync(f.path)).toBe(true);
    expect(activeWorktrees.has(f.name)).toBe(false);
  });

  it("adopts a dead owner's dirty worktree without committing or merging it", async () => {
    const f = fixture("dirty");
    writeFileSync(join(f.path, "unfinished.txt"), "valuable work\n");

    const result = await reconcileWorktreeBase(f.base, () => false);
    const recovered = pendingRecoveredWorktrees.get(f.name);

    expect(result).toEqual([expect.objectContaining({
      disposition: "recoverable",
      reason: "uncommitted work preserved and quarantined",
    })]);
    expect(recovered?.recovered).toBe(true);
    expect(existsSync(join(f.path, "unfinished.txt"))).toBe(true);
    expect(run(f.repo, ["ls-tree", "--name-only", "main"])).not.toContain("unfinished.txt");
  });

  it("returns an adopted worktree to the matching autonomous caller", async () => {
    const f = fixture("resume");
    writeFileSync(join(f.path, "unfinished.txt"), "resume me\n");
    await reconcileWorktreeBase(f.base, () => false);

    const resumed = createNamedWorktree(f.name, f.branch, f.repo, f.name);

    expect(resumed).toEqual({ path: f.path, branch: f.branch, baseBranch: "main" });
    expect(activeWorktrees.get(f.name)?.recovered).toBe(false);
    expect(existsSync(join(f.path, "unfinished.txt"))).toBe(true);
  });

  it("recovers a clean branch when it contains commits not on the base", async () => {
    const f = fixture("committed");
    writeFileSync(join(f.path, "finished.txt"), "finished but not merged\n");
    run(f.path, ["add", "finished.txt"]);
    run(f.path, ["commit", "-m", "finished work"]);

    const result = await reconcileWorktreeBase(f.base, () => false);

    expect(result).toEqual([expect.objectContaining({
      disposition: "recoverable",
      reason: "unmerged branch preserved and quarantined",
    })]);
    expect(run(f.repo, ["ls-tree", "--name-only", "main"])).not.toContain("finished.txt");
  });

  it("checkpoints fresh dirty worktrees during process shutdown", () => {
    const f = fixture("shutdown");
    writeFileSync(join(f.path, "unfinished.txt"), "survive shutdown\n");
    activeWorktrees.set(f.name, f.entry);

    cleanupAllWorktrees();

    expect(existsSync(join(f.path, "unfinished.txt"))).toBe(true);
    expect(run(f.path, ["show", "HEAD:unfinished.txt"])).toBe("survive shutdown");
    expect(activeWorktrees.get(f.name)?.recovered).toBe(true);
  });

  it("checkpoints a claimed recovered worktree during shutdown", async () => {
    const f = fixture("claimed-shutdown");
    writeFileSync(join(f.path, "before.txt"), "before\n");
    await reconcileWorktreeBase(f.base, () => false);
    expect(createNamedWorktree(f.name, f.branch, f.repo, f.name)).not.toBeNull();
    writeFileSync(join(f.path, "after.txt"), "after\n");

    cleanupAllWorktrees();

    expect(run(f.path, ["show", "HEAD:after.txt"])).toBe("after");
    expect(existsSync(f.path)).toBe(true);
  });

  it("preserves a clean active branch with commits not integrated into base", () => {
    const f = fixture("clean-unmerged-shutdown");
    writeFileSync(join(f.path, "committed.txt"), "finished locally\n");
    run(f.path, ["add", "committed.txt"]);
    run(f.path, ["commit", "-m", "unfinished operation commit"]);
    activeWorktrees.set(f.name, f.entry);

    cleanupAllWorktrees();

    expect(existsSync(f.path)).toBe(true);
    expect(activeWorktrees.get(f.name)?.recovered).toBe(true);
    expect(run(f.repo, ["ls-tree", "--name-only", "main"])).not.toContain("committed.txt");
  });

  it("does not count quarantined recoveries against the active cap", async () => {
    const many = Array.from({ length: MAX_CONCURRENT_WORKTREES + 1 }, (_, i) => fixture(`queued-${i}`));
    for (const f of many) writeFileSync(join(f.path, "work.txt"), "pending\n");

    const results = (await Promise.all(many.map(f => reconcileWorktreeBase(f.base, () => false)))).flat();

    expect(results).toHaveLength(MAX_CONCURRENT_WORKTREES + 1);
    expect(activeWorktrees.size).toBe(0);
    expect(pendingRecoveredWorktrees.size).toBe(MAX_CONCURRENT_WORKTREES + 1);

    for (let i = 0; i < MAX_CONCURRENT_WORKTREES; i++) {
      activeWorktrees.set(`active-${i}`, many[0].entry);
    }
    expect(createNamedWorktree(many[0].name, many[0].branch, many[0].repo, many[0].name)).toBeNull();
    expect(pendingRecoveredWorktrees.has(many[0].name)).toBe(true);
  });

  it("preserves recoverable work when the bounded quarantine is full", async () => {
    const f = fixture("quarantine-full");
    writeFileSync(join(f.path, "work.txt"), "pending\n");
    for (let i = 0; i < MAX_PENDING_RECOVERED_WORKTREES; i++) {
      pendingRecoveredWorktrees.set(`occupied-${i}`, f.entry);
    }

    const result = await reconcileWorktreeBase(f.base, () => false);

    expect(result).toEqual([expect.objectContaining({
      disposition: "ambiguous", reason: "recovery quarantine is full; work preserved",
    })]);
    expect(existsSync(join(f.path, "work.txt"))).toBe(true);
  });

  it("does not resume an unrelated build that reused the autobuild chunk name", async () => {
    const f = fixture("autobuild-c7", true, "build-one:chunk:7");
    writeFileSync(join(f.path, "work.txt"), "first run\n");
    await reconcileWorktreeBase(f.base, () => false);

    const unrelated = createNamedWorktree(f.name, f.branch, f.repo, "build-two:chunk:7");

    expect(unrelated).toBeNull();
    expect(pendingRecoveredWorktrees.get(f.name)?.runId).toBe("build-one:chunk:7");
    expect(existsSync(join(f.path, "work.txt"))).toBe(true);
  });

  it("reclaims a stale crash lease", async () => {
    const f = fixture("stale-claim");
    writeFileSync(join(f.path, "work.txt"), "recover\n");
    writeFileSync(`${worktreeOwnershipRecordPath(f.path)}.claim`, JSON.stringify({
      pid: 999999, incarnation: "999999:old", token: "stale", createdAt: new Date().toISOString(),
    }));

    const result = await reconcileWorktreeBase(f.base, () => false);

    expect(result).toEqual([expect.objectContaining({ disposition: "recoverable" })]);
  });

  it.each([
    ["empty", ""],
    ["truncated", '{"pid":123'],
  ])("recovers an %s claim left by a pre-publication crash", async (label, contents) => {
    const f = fixture(`malformed-claim-${label}`);
    writeFileSync(join(f.path, "work.txt"), "recover\n");
    writeFileSync(`${worktreeOwnershipRecordPath(f.path)}.claim`, contents);

    const result = await reconcileWorktreeBase(f.base, () => false);

    expect(result).toEqual([expect.objectContaining({ disposition: "recoverable" })]);
    expect(pendingRecoveredWorktrees.has(f.name)).toBe(true);
  });

  it("does not steal a replacement claimant during stale-lease ABA", async () => {
    const f = fixture("claim-aba");
    writeFileSync(join(f.path, "work.txt"), "recover\n");
    const claimPath = `${worktreeOwnershipRecordPath(f.path)}.claim`;
    writeFileSync(claimPath, JSON.stringify({
      pid: 999999, incarnation: "999999:stale", token: "stale-a", createdAt: new Date().toISOString(),
    }));
    const replacement = {
      pid: process.pid, incarnation: currentProcessIncarnation(), token: "live-b", createdAt: new Date().toISOString(),
    };

    const result = await reconcileWorktreeBase(f.base, () => false, {
      beforeStaleRename: path => {
        rmSync(path, { force: true });
        writeFileSync(path, JSON.stringify(replacement));
      },
    });

    expect(result).toEqual([expect.objectContaining({
      disposition: "ambiguous", reason: "ownership claim is contested",
    })]);
    expect(JSON.parse(readFileSync(claimPath, "utf-8"))).toEqual(replacement);
    expect(pendingRecoveredWorktrees.has(f.name)).toBe(false);
  });

  it("does not treat a reused pid as the original live owner", async () => {
    const f = fixture("pid-reuse");
    writeFileSync(join(f.path, "work.txt"), "recover\n");
    const current = currentProcessIncarnation();

    const result = await reconcileWorktreeBase(
      f.base,
      (pid, incarnation) => pid === process.pid && incarnation === `${current}:different`,
    );

    expect(result).toEqual([expect.objectContaining({ disposition: "recoverable" })]);
  });

  it("rechecks the ownership generation immediately before handoff", async () => {
    const f = fixture("handoff-fence");
    writeFileSync(join(f.path, "work.txt"), "recover\n");
    await reconcileWorktreeBase(f.base, () => false);

    const claimed = claimRecoveredWorktree({
      name: f.name, branch: f.branch, runId: f.name, repoRoot: f.repo, baseBranch: "main",
      beforeReturn: () => {
        const pending = activeWorktrees.get(f.name)!;
        registerWorktreeOwnership(f.name, pending, f.name);
      },
    });

    expect(claimed).toBeNull();
    expect(activeWorktrees.has(f.name)).toBe(false);
    expect(existsSync(f.path)).toBe(true);
  });

  it("preserves an unowned registered worktree as ambiguous", async () => {
    const f = fixture("unowned", false);
    writeFileSync(join(f.path, "unfinished.txt"), "do not delete\n");

    const result = await reconcileWorktreeBase(f.base, () => false);

    expect(result).toEqual([expect.objectContaining({ disposition: "ambiguous" })]);
    expect(existsSync(join(f.path, "unfinished.txt"))).toBe(true);
    expect(activeWorktrees.has(f.name)).toBe(false);
  });

  it("preserves an unregistered directory containing possible work", async () => {
    const root = mkdtempSync(join(tmpdir(), "lax-wt-ambiguous-"));
    extraRoots.push(root);
    const base = join(root, "worktrees");
    const path = join(base, "unknown");
    mkdirSync(path, { recursive: true });
    writeFileSync(join(path, "work.txt"), "possibly valuable\n");

    const result = await reconcileWorktreeBase(base, () => false);

    expect(result).toEqual([expect.objectContaining({ disposition: "ambiguous" })]);
    expect(existsSync(join(path, "work.txt"))).toBe(true);
  });

  it("preserves identity drift instead of trusting a stale record", async () => {
    const f = fixture("drift");
    run(f.path, ["checkout", "-b", "agent/other"]);

    const result = await reconcileWorktreeBase(f.base, () => false);

    expect(result).toEqual([expect.objectContaining({ disposition: "ambiguous" })]);
    expect(existsSync(f.path)).toBe(true);
  });

  it("removes only a clean worktree whose branch is already integrated", async () => {
    const f = fixture("integrated");

    const result = await reconcileWorktreeBase(f.base, () => false);

    expect(result).toEqual([expect.objectContaining({ disposition: "disposable" })]);
    expect(existsSync(f.path)).toBe(false);
  });

  it.skipIf(!CAN_CREATE_DIR_LINK)("unlinks unknown shallow reparse points without touching their targets", async () => {
    const f = fixture("linked");
    const outside = join(f.repo, "outside");
    mkdirSync(outside);
    writeFileSync(join(outside, "sentinel.txt"), "keep\n");
    writeFileSync(join(f.repo, ".git", "info", "exclude"), "future-link\n");
    symlinkSync(outside, join(f.path, "future-link"), process.platform === "win32" ? "junction" : "dir");

    const result = await reconcileWorktreeBase(f.base, () => false);

    expect(result).toEqual([expect.objectContaining({ disposition: "disposable" })]);
    expect(existsSync(join(outside, "sentinel.txt"))).toBe(true);
  });

  it("a newer ownership generation fences the stale process from cleanup", () => {
    const f = fixture("fenced");
    activeWorktrees.set(f.name, f.entry);
    registerWorktreeOwnership(f.name, f.entry);

    expect(ownsWorktree(f.entry)).toBe(false);
    cleanupWorktree(f.name);
    expect(existsSync(f.path)).toBe(true);
    expect(activeWorktrees.has(f.name)).toBe(false);
  });
});
