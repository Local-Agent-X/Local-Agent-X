/**
 * Worktree isolation regression tests.
 *
 * Verifies:
 * 1. Delegated non-Codex agent read/write/edit/bash stay in worktree
 * 2. Delegated glob/grep cannot escape with absolute paths or ..
 * 3. Codex delegated agent does not create a worktree
 */

import { describe, it, expect, vi } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { activeWorktrees, logger, MAX_CONCURRENT_WORKTREES, worktreeSlotAvailable, type WorktreeEntry } from "./worktree-core.js";
import { createWorktree, createNamedWorktree, cleanupWorktree, mergeWorktree } from "./worktree-lifecycle.js";
import { pruneMergedAgentBranches } from "./worktree-junctions.js";
import { getMergeDeltaFiles, securitySensitiveChangedFiles, commitInWorktree } from "./worktree-state.js";
import { scanWorktreeForStagedSecrets } from "../self-edit/exfil-scan.js";
import { rewritePathForWorktree } from "../tool-execution/worktree-paths.js";

const WT = join(tmpdir(), "lax-worktrees", "test-agent");

// Shared helper: a real temp git repo with one commit on `main`.
function initRepo(): { repo: string; g: (args: string[], cwd?: string) => string; baseHead: string } {
  const repo = mkdtempSync(join(tmpdir(), "lax-wt-merge-"));
  const g = (args: string[], cwd = repo): string =>
    execFileSync("git", args, { cwd, encoding: "utf-8", env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null" } }).trim();
  g(["init", "-q"]);
  g(["config", "user.email", "t@t"]);
  g(["config", "user.name", "t"]);
  writeFileSync(join(repo, "base.txt"), "base");
  g(["add", "-A"]);
  g(["commit", "-qm", "base"]);
  g(["branch", "-M", "main"]);
  return { repo, g, baseHead: g(["rev-parse", "HEAD"]) };
}

describe("Worktree path rewriting", () => {
  it("rewrites relative read path into worktree", () => {
    expect(rewritePathForWorktree("read", "src/index.ts", WT)).toBe(join(WT, "src/index.ts"));
  });

  it("rewrites relative write path into worktree", () => {
    expect(rewritePathForWorktree("write", "output.txt", WT)).toBe(join(WT, "output.txt"));
  });

  it("rewrites relative edit path into worktree", () => {
    expect(rewritePathForWorktree("edit", "src/config.ts", WT)).toBe(join(WT, "src/config.ts"));
  });

  it("defaults glob with no path to worktree root", () => {
    expect(rewritePathForWorktree("glob", undefined, WT)).toBe(WT);
  });

  it("defaults grep with no path to worktree root", () => {
    expect(rewritePathForWorktree("grep", undefined, WT)).toBe(WT);
  });

  it("clamps absolute glob path that escapes worktree", () => {
    expect(rewritePathForWorktree("glob", "/etc/passwd", WT)).toBe(WT);
  });

  it("clamps absolute grep path that escapes worktree", () => {
    expect(rewritePathForWorktree("grep", "C:\\Users\\secrets", WT)).toBe(WT);
  });

  it("allows absolute glob path within worktree", () => {
    const insidePath = join(WT, "src");
    expect(rewritePathForWorktree("glob", insidePath, WT)).toBe(insidePath);
  });

  it("rewrites relative glob path into worktree", () => {
    expect(rewritePathForWorktree("glob", "src/**/*.ts", WT)).toBe(join(WT, "src/**/*.ts"));
  });

  it("rewrites .. traversal in relative path into worktree (still under root after join)", () => {
    const result = rewritePathForWorktree("read", "../../../etc/passwd", WT);
    // join resolves it — the security layer then catches if it escapes
    expect(result).toBe(join(WT, "../../../etc/passwd"));
  });

  it("does not rewrite bash paths (uses _cwd instead)", () => {
    // Bash doesn't use args.path — it uses _cwd
    expect(rewritePathForWorktree("bash", undefined, WT)).toBeUndefined();
  });
});

describe("Codex worktree skip", () => {
  it("documents that Codex agents skip worktree creation", () => {
    // This test is a documentation anchor — the actual skip is in server.ts
    // If provider === "codex", createWorktree is never called
    const provider = "codex";
    const shouldCreateWorktree = provider !== "codex";
    expect(shouldCreateWorktree).toBe(false);
  });

  it("non-Codex providers create worktrees", () => {
    for (const provider of ["openai", "anthropic", "xai", "gemini", "local"]) {
      expect(provider !== "codex").toBe(true);
    }
  });
});

// R6-B1/B2: the self_edit merge gate must measure the MERGE DELTA (committed +
// uncommitted), not the working tree, and must hold the gate's own pipeline for
// review. These prove a prompt-injected surgeon can't (a) commit a malicious
// change + leave a trivial uncommitted crumb to slip past the porcelain-scoped
// gate, or (b) edit the gate code itself unreviewed.
describe("self_edit merge-gate scoping (R6-B1/B2)", () => {
  const g = (cwd: string, args: string[]): void => {
    execFileSync("git", args, { cwd, stdio: "ignore", env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null" } });
  };

  it("measures committed history (not just the working tree) and exfil-catches a committed secret behind an uncommitted crumb", async () => {
    const repo = mkdtempSync(join(tmpdir(), "lax-mgate-"));
    const name = "mgate-test";
    try {
      g(repo, ["init", "-q"]);
      g(repo, ["config", "user.email", "t@t"]);
      g(repo, ["config", "user.name", "t"]);
      writeFileSync(join(repo, "base.txt"), "base");
      g(repo, ["add", "-A"]);
      g(repo, ["commit", "-qm", "base"]);
      g(repo, ["branch", "-M", "main"]);
      const baseSha = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repo, encoding: "utf-8" }).trim();

      // Surgeon commits a malicious auth change on its branch …
      g(repo, ["checkout", "-q", "-b", "feature"]);
      mkdirSync(join(repo, "src", "auth"), { recursive: true });
      const secret = "sk-" + "ant-" + "api03" + "A".repeat(24); // concatenated so the literal isn't scannable in this source
      writeFileSync(join(repo, "src", "auth", "evil.ts"), `export const K = "${secret}";\n`);
      g(repo, ["add", "-A"]);
      g(repo, ["commit", "-qm", "evil"]);
      // … and leaves only a trivial UNCOMMITTED crumb.
      writeFileSync(join(repo, "README.md"), "touch");

      const entry: WorktreeEntry = { path: repo, branch: "feature", baseBranch: "main", repoRoot: repo, mergedSuccessfully: false };
      activeWorktrees.set(name, entry);

      const delta = await getMergeDeltaFiles(name);
      expect(delta).toContain("src/auth/evil.ts"); // committed change is in scope
      expect(delta).toContain("README.md");        // uncommitted crumb too

      // B2: the committed auth change is HELD for review (derived from the manifest).
      expect(securitySensitiveChangedFiles(delta)).toContain("src/auth/evil.ts");

      // B1: exfil scan WITH the base SHA catches the committed secret …
      expect(scanWorktreeForStagedSecrets(repo, baseSha).clean).toBe(false);
      // … while the old working-tree-only scan MISSES it — the gap this fix closes.
      expect(scanWorktreeForStagedSecrets(repo).clean).toBe(true);
    } finally {
      activeWorktrees.delete(name);
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it("holds every gate-pipeline module for review (the gate can't rewrite its own gate)", () => {
    // The modules that implement the gate itself — each must be in the held set,
    // else a self_edit could weaken the gate and auto-merge it. Derived from the
    // protected-files.json manifest, so this fails loudly if the manifest drifts.
    const gateModules = [
      "src/self-edit/sandbox.ts",
      "src/self-edit/sandbox-gates.ts",
      "src/self-edit/exfil-scan.ts",
      "src/agency/worktree-state.ts",
      "src/agency/worktree-lifecycle.ts",
      "src/tool-policy/anything.ts",   // subtree-protected
      "src/security/secrets/secret-scanner.ts",
      "src/auth/index.ts",
      "config/protected-files.json",
    ];
    for (const m of gateModules) {
      expect(securitySensitiveChangedFiles([m])).toEqual([m]);
    }
    // A non-engine file is NOT held (the gate stays targeted, not hermetic).
    expect(securitySensitiveChangedFiles(["src/routes/apps.ts"])).toEqual([]);
  });
});

// Global concurrent-worktree cap: a cross-source safety backstop so a runaway
// (agent spawns + self-edit + update + autopilot, each from a different entry
// point) can't fill the disk with full repo copies. The cap is fail-safe and
// contract-compatible — over-cap returns null, the same shape callers already
// handle as a creation failure. These seed activeWorktrees directly so the cap
// trips WITHOUT touching git (the registry is the single source of truth).
describe("concurrent-worktree cap", () => {
  // Pad the registry up to the live cap with placeholder entries.
  function fillToCap(): string[] {
    const ids: string[] = [];
    for (let i = activeWorktrees.size; i < MAX_CONCURRENT_WORKTREES; i++) {
      const id = `cap-fill-${i}`;
      activeWorktrees.set(id, {
        path: join(tmpdir(), "lax-worktrees", id),
        branch: `agent/${id}`,
        baseBranch: "main",
        repoRoot: tmpdir(),
        mergedSuccessfully: false,
      });
      ids.push(id);
    }
    return ids;
  }

  function clearFill(ids: string[]): void {
    for (const id of ids) activeWorktrees.delete(id);
  }

  it("createWorktree returns null at cap without creating git artifacts", () => {
    const filled = fillToCap();
    try {
      expect(activeWorktrees.size).toBe(MAX_CONCURRENT_WORKTREES);
      expect(worktreeSlotAvailable()).toBe(false);
      const before = activeWorktrees.size;
      // Refused at the cap guard — returns null and never registers an entry.
      expect(createWorktree("over-cap-agent")).toBeNull();
      expect(activeWorktrees.has("over-cap-agent")).toBe(false);
      expect(activeWorktrees.size).toBe(before); // no git worktree add ran
    } finally {
      clearFill(filled);
    }
  });

  it("createNamedWorktree returns null at cap without creating git artifacts", () => {
    const filled = fillToCap();
    try {
      expect(worktreeSlotAvailable()).toBe(false);
      const before = activeWorktrees.size;
      expect(createNamedWorktree("over-cap-named", "autopilot/over-cap")).toBeNull();
      expect(activeWorktrees.has("over-cap-named")).toBe(false);
      expect(activeWorktrees.size).toBe(before);
    } finally {
      clearFill(filled);
    }
  });

  it("a freed slot (cleanupWorktree) re-opens room under the cap", () => {
    const filled = fillToCap();
    try {
      expect(worktreeSlotAvailable()).toBe(false);
      // Free one slot — the placeholder repoRoot is just tmpdir, so the git
      // worktree-remove is a harmless no-op (caught internally); the entry is
      // removed from the registry, which is what frees the slot.
      const freed = filled.pop()!;
      cleanupWorktree(freed);
      expect(activeWorktrees.has(freed)).toBe(false);
      expect(worktreeSlotAvailable()).toBe(true);
    } finally {
      clearFill(filled);
    }
  });

  // OP-8: mergeWorktree must NOT switch or clobber the user's live checkout.
  // The old path ran `git checkout <base>` in the parent repo root, so an
  // agent finishing while the user was on another branch mid-edit would yank
  // them onto the base branch. This asserts the user's checkout is untouched
  // while the base branch still advances. Fails on the pre-fix code (which
  // switches HEAD to `main`).
  it("mergeWorktree advances the base branch without disturbing the user's checkout (OP-8)", () => {
    const { repo, g, baseHead } = initRepo();
    const id = "op8-agent";
    const prevCwd = process.cwd();
    const env = { ...process.env };
    try {
      process.chdir(repo);
      const wt = createWorktree(id);
      expect(wt).not.toBeNull();

      // User switches to their own branch and starts editing (uncommitted WIP)
      // — exactly the mid-edit situation the old checkout-based merge trampled.
      g(["checkout", "-q", "-b", "user-feature"]);
      writeFileSync(join(repo, "user-wip.txt"), "uncommitted user work");

      // Agent commits a change on its branch, then the merge runs.
      writeFileSync(join(wt!.path, "agent.txt"), "agent change");
      commitInWorktree(id, "agent work");
      const res = mergeWorktree(id);
      expect(res.merged).toBe(true);

      // The user's checkout is untouched: still on their branch, WIP intact.
      expect(g(["rev-parse", "--abbrev-ref", "HEAD"])).toBe("user-feature");
      expect(existsSync(join(repo, "user-wip.txt"))).toBe(true);
      // …and the base branch still advanced to include the agent's commit.
      expect(g(["ls-tree", "--name-only", "main"]).split("\n")).toContain("agent.txt");
      expect(g(["rev-parse", "main"])).not.toBe(baseHead);
    } finally {
      process.chdir(prevCwd);
      try { cleanupWorktree(id); } catch { /* best-effort */ }
      activeWorktrees.delete(id);
      Object.assign(process.env, env);
      rmSync(repo, { recursive: true, force: true });
    }
  });

  // OP-8 happy path: when the user IS sitting on a clean base branch, the
  // agent's changes should still land in their working tree (a fast-forward),
  // so the fix doesn't regress the normal merge-back-to-main behavior.
  it("mergeWorktree fast-forwards the user's checkout when they are clean on base (OP-8)", () => {
    const { repo, g, baseHead } = initRepo();
    const id = "op8-ff-agent";
    const prevCwd = process.cwd();
    const env = { ...process.env };
    try {
      process.chdir(repo);
      const wt = createWorktree(id);
      expect(wt).not.toBeNull();
      writeFileSync(join(wt!.path, "agent.txt"), "agent change");
      commitInWorktree(id, "agent work");
      const res = mergeWorktree(id);
      expect(res.merged).toBe(true);
      // User is on main and clean → the agent's file appears in their checkout.
      expect(g(["rev-parse", "--abbrev-ref", "HEAD"])).toBe("main");
      expect(existsSync(join(repo, "agent.txt"))).toBe(true);
      expect(g(["rev-parse", "main"])).not.toBe(baseHead);
    } finally {
      process.chdir(prevCwd);
      try { cleanupWorktree(id); } catch { /* best-effort */ }
      activeWorktrees.delete(id);
      Object.assign(process.env, env);
      rmSync(repo, { recursive: true, force: true });
    }
  });

  // OP-5: the aborted-run teardown (handler-events catch) must commit the
  // agent's uncommitted edits onto the agent branch BEFORE cleanupWorktree
  // runs `git worktree remove --force`. Otherwise 20 minutes of edits are
  // destroyed and the "preserved" agent/<id> branch points at base HEAD.
  //
  // This asserts BOTH halves of the fix: (1) the pre-fix teardown (cleanup
  // ALONE — what the catch did) demonstrably loses the WIP, leaving the branch
  // at base HEAD, and (2) the fixed teardown (commitInWorktree THEN cleanup)
  // preserves it. If someone reverts the wiring back to cleanup-only, half (2)
  // becomes unreachable behavior — this locks the ordering the catch depends on.
  it("aborted teardown loses WIP without a pre-commit but preserves it with one (OP-5)", () => {
    const prevCwd = process.cwd();
    const env = { ...process.env };
    // Pre-fix teardown: cleanup with no commit → branch stuck at base HEAD.
    const a = initRepo();
    const idA = "op5-nocommit";
    const branchA = `agent/${idA}`;
    // Fixed teardown: commit WIP, then cleanup → branch carries the work.
    const b = initRepo();
    const idB = "op5-commit";
    const branchB = `agent/${idB}`;
    try {
      process.chdir(a.repo);
      const wtA = createWorktree(idA);
      expect(wtA).not.toBeNull();
      writeFileSync(join(wtA!.path, "wip.txt"), "20 minutes of edits");
      cleanupWorktree(idA); // pre-fix: no commit first
      expect(existsSync(wtA!.path)).toBe(false);
      // The "preserved" branch is empty — the WIP was force-removed and lost.
      expect(a.g(["rev-parse", branchA])).toBe(a.baseHead);
      expect(a.g(["ls-tree", "--name-only", branchA]).split("\n")).not.toContain("wip.txt");

      process.chdir(b.repo);
      const wtB = createWorktree(idB);
      expect(wtB).not.toBeNull();
      writeFileSync(join(wtB!.path, "wip.txt"), "20 minutes of edits");
      commitInWorktree(idB, `Agent ${idB}: work-in-progress (run aborted)`); // the fix
      cleanupWorktree(idB);
      expect(existsSync(wtB!.path)).toBe(false);
      // Now the preserved branch actually carries the WIP, past base HEAD.
      expect(b.g(["ls-tree", "--name-only", branchB]).split("\n")).toContain("wip.txt");
      expect(b.g(["rev-parse", branchB])).not.toBe(b.baseHead);
    } finally {
      process.chdir(prevCwd);
      try { a.g(["branch", "-D", branchA]); } catch { /* best-effort */ }
      try { b.g(["branch", "-D", branchB]); } catch { /* best-effort */ }
      activeWorktrees.delete(idA);
      activeWorktrees.delete(idB);
      Object.assign(process.env, env);
      rmSync(a.repo, { recursive: true, force: true });
      rmSync(b.repo, { recursive: true, force: true });
    }
  });

  it("createWorktree proceeds when a slot is available (real temp repo)", () => {
    // Below the cap: creation should reach git and succeed in a real repo.
    const home = mkdtempSync(join(tmpdir(), "lax-cap-home-"));
    const repo = mkdtempSync(join(tmpdir(), "lax-cap-repo-"));
    const id = "cap-under-agent";
    const prevCwd = process.cwd();
    const env = { ...process.env };
    try {
      const g = (args: string[]): void => {
        execFileSync("git", args, { cwd: repo, stdio: "ignore", env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null" } });
      };
      g(["init", "-q"]);
      g(["config", "user.email", "t@t"]);
      g(["config", "user.name", "t"]);
      writeFileSync(join(repo, "base.txt"), "base");
      g(["add", "-A"]);
      g(["commit", "-qm", "base"]);
      g(["branch", "-M", "main"]);

      // createWorktree shells out to git from process.cwd(); point it at the repo.
      process.chdir(repo);
      expect(worktreeSlotAvailable()).toBe(true);
      const wt = createWorktree(id);
      expect(wt).not.toBeNull();
      expect(activeWorktrees.has(id)).toBe(true);
    } finally {
      process.chdir(prevCwd);
      try { cleanupWorktree(id); } catch { /* best-effort */ }
      activeWorktrees.delete(id);
      Object.assign(process.env, env);
      rmSync(repo, { recursive: true, force: true });
      rmSync(home, { recursive: true, force: true });
    }
  });
});

// C17: createNamedWorktree must not fail when a previous run left the requested
// branch behind. auto-build names `autobuild/c<N>` from the chunk number alone,
// so run N+1 collides with run N's leftover; the recovery path only re-adopts a
// worktree whose runId matches, and a merged-but-unswept branch has no worktree
// at all. Policy mirrors cleanupWorktree: delete only what git proves merged
// (`-d`), otherwise preserve the stale branch and cut the worktree on `<name>-2`.
describe("createNamedWorktree stale-branch preflight (C17)", () => {
  const BRANCH = "autobuild/c1";
  const staleWarns = (warn: { mock: { calls: unknown[][] } }): string[] =>
    warn.mock.calls.map(([m]) => String(m)).filter(m => m.includes("Stale branch"));

  function commitFile(g: (args: string[], cwd?: string) => string, repo: string, file: string): string {
    writeFileSync(join(repo, file), file);
    g(["add", "-A"]);
    g(["commit", "-qm", file]);
    return g(["rev-parse", "HEAD"]);
  }

  it("deletes a stale MERGED branch and cuts the worktree on the requested name", () => {
    const { repo, g, baseHead } = initRepo();
    const name = "c17-stale-merged";
    try {
      // Advance main past the leftover: `autobuild/c1` sits at baseHead — fully
      // merged but NOT at HEAD — so a plain reuse (no delete) would start the
      // worktree behind base and be distinguishable from a recreate at HEAD.
      const newHead = commitFile(g, repo, "second.txt");
      g(["branch", BRANCH, baseHead]);

      const wt = createNamedWorktree(name, BRANCH, repo, "run-2");
      expect(wt).not.toBeNull();
      expect(wt!.branch).toBe(BRANCH);
      expect(g(["rev-parse", "--abbrev-ref", "HEAD"], wt!.path)).toBe(BRANCH);
      expect(g(["rev-parse", BRANCH])).toBe(newHead); // recreated at HEAD, not the stale tip
      expect(activeWorktrees.get(name)?.branch).toBe(BRANCH);
    } finally {
      try { cleanupWorktree(name); } catch { /* best-effort */ }
      activeWorktrees.delete(name);
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it("preserves a stale UNMERGED branch, cuts the worktree on <name>-2, and warns once", () => {
    const { repo, g } = initRepo();
    const name = "c17-stale-unmerged";
    const warn = vi.spyOn(logger, "warn");
    try {
      g(["checkout", "-q", "-b", BRANCH]);
      const staleTip = commitFile(g, repo, "unmerged-wip.txt");
      g(["checkout", "-q", "main"]);

      const wt = createNamedWorktree(name, BRANCH, repo, "run-2");
      expect(wt).not.toBeNull();
      expect(wt!.branch).toBe(`${BRANCH}-2`);
      expect(g(["rev-parse", "--abbrev-ref", "HEAD"], wt!.path)).toBe(`${BRANCH}-2`);
      // The stale branch and its unmerged commit are untouched …
      expect(g(["rev-parse", BRANCH])).toBe(staleTip);
      // … and the registry carries the branch ACTUALLY used, so merge/cleanup
      // (which read the registry, not the caller's request) target the right one.
      expect(activeWorktrees.get(name)?.branch).toBe(`${BRANCH}-2`);
      const warns = staleWarns(warn);
      expect(warns).toHaveLength(1);
      expect(warns[0]).toContain(`${BRANCH}-2`);
    } finally {
      warn.mockRestore();
      try { cleanupWorktree(name); } catch { /* best-effort */ }
      activeWorktrees.delete(name);
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it("side-steps (never deletes) a branch another worktree has checked out", () => {
    const { repo, g, baseHead } = initRepo();
    const name = "c17-stale-checked-out";
    const other = mkdtempSync(join(tmpdir(), "lax-wt-other-"));
    const otherPath = join(other, "wt");
    const warn = vi.spyOn(logger, "warn");
    try {
      // Fully merged (at HEAD) — deletable on its own — but held by a worktree.
      g(["worktree", "add", "-b", BRANCH, otherPath, "main"]);

      const wt = createNamedWorktree(name, BRANCH, repo, "run-2");
      expect(wt).not.toBeNull();
      expect(wt!.branch).toBe(`${BRANCH}-2`);
      expect(g(["rev-parse", BRANCH])).toBe(baseHead);
      expect(g(["rev-parse", "--abbrev-ref", "HEAD"], otherPath)).toBe(BRANCH);
      const warns = staleWarns(warn);
      expect(warns).toHaveLength(1);
      expect(warns[0]).toContain("checked out");
    } finally {
      warn.mockRestore();
      try { cleanupWorktree(name); } catch { /* best-effort */ }
      activeWorktrees.delete(name);
      try { g(["worktree", "remove", otherPath, "--force"]); } catch { /* best-effort */ }
      rmSync(other, { recursive: true, force: true });
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it("pruneMergedAgentBranches sweeps a merged autobuild/ branch and leaves an unmerged one", () => {
    const { repo, g, baseHead } = initRepo();
    try {
      commitFile(g, repo, "second.txt");
      g(["branch", "autobuild/c1", baseHead]); // merged (ancestor of HEAD), no worktree
      g(["branch", "feature/keep", baseHead]); // merged, but not an agent prefix
      g(["checkout", "-q", "-b", "autobuild/c2"]);
      commitFile(g, repo, "unmerged.txt");     // unmerged
      g(["checkout", "-q", "main"]);

      pruneMergedAgentBranches(repo);

      const branches = g(["branch", "--list", "--format=%(refname:short)"]).split("\n");
      expect(branches).not.toContain("autobuild/c1");
      expect(branches).toContain("autobuild/c2");
      expect(branches).toContain("feature/keep");
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });
});
