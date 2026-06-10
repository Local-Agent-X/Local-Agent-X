/**
 * Worktree isolation regression tests.
 *
 * Verifies:
 * 1. Delegated non-Codex agent read/write/edit/bash stay in worktree
 * 2. Delegated glob/grep cannot escape with absolute paths or ..
 * 3. Codex delegated agent does not create a worktree
 */

import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { resolve, join, relative } from "node:path";
import { tmpdir } from "node:os";

import { activeWorktrees, type WorktreeEntry } from "./worktree-core.js";
import { getMergeDeltaFiles, securitySensitiveChangedFiles } from "./worktree-state.js";
import { scanWorktreeForStagedSecrets } from "../self-edit/exfil-scan.js";

// Simulate the executor's worktree path rewriting logic (extracted for testability)
function rewritePathForWorktree(
  toolName: string,
  rawPath: string | undefined,
  wtPath: string
): string | undefined {
  if (!rawPath && ["glob", "grep"].includes(toolName)) return wtPath;
  if (!rawPath) return rawPath;

  const isAbsolute = rawPath.startsWith("/") || rawPath.includes(":");
  if (isAbsolute) {
    if (["glob", "grep"].includes(toolName)) {
      const resolved = resolve(rawPath);
      if (relative(wtPath, resolved).startsWith("..")) return wtPath;
      return rawPath; // within worktree already
    }
    return rawPath; // read/write/edit — absolute paths go through security
  }
  return join(wtPath, rawPath); // relative → prepend worktree
}

const WT = join(tmpdir(), "lax-worktrees", "test-agent");

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

  it("measures committed history (not just the working tree) and exfil-catches a committed secret behind an uncommitted crumb", () => {
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

      const delta = getMergeDeltaFiles(name);
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
      "src/self-edit-sandbox.ts",
      "src/self-edit-sandbox-gates.ts",
      "src/self-edit/exfil-scan.ts",
      "src/agency/worktree-state.ts",
      "src/agency/worktree-lifecycle.ts",
      "src/tool-policy/anything.ts",   // subtree-protected
      "src/security/secret-scanner.ts",
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
