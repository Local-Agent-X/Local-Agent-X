/**
 * Tests for the deps-change detection predicate used by the self_edit
 * sandbox's deps gate.
 *
 * changedFilesTouchDeps decides whether a sandboxed edit changed a dependency
 * manifest — the trigger for replacing the shared node_modules junction with a
 * real isolated `npm ci` (so the install can't corrupt the parent repo's deps).
 * It matches on basename so nested workspace manifests count too. The actual
 * junction-drop + npm ci side-effects need a live worktree, so those are
 * exercised end-to-end; here we lock the pure predicate.
 */

import { describe, it, expect } from "vitest";
import { changedFilesTouchDeps, securitySensitiveChangedFiles } from "../src/agency/worktree.js";

describe("changedFilesTouchDeps", () => {
  it("returns false for an empty change list", () => {
    expect(changedFilesTouchDeps([])).toBe(false);
  });

  it("returns false when only source files changed", () => {
    expect(changedFilesTouchDeps(["src/foo.ts"])).toBe(false);
  });

  it("returns true when root package.json changed", () => {
    expect(changedFilesTouchDeps(["package.json"])).toBe(true);
  });

  it("returns true when package-lock.json changed", () => {
    expect(changedFilesTouchDeps(["package-lock.json"])).toBe(true);
  });

  it("returns true for a nested workspace package.json", () => {
    expect(changedFilesTouchDeps(["packages/arikernel/package.json"])).toBe(true);
  });
});

describe("securitySensitiveChangedFiles", () => {
  it("returns [] when no security-sensitive files changed", () => {
    expect(securitySensitiveChangedFiles(["src/foo.ts", "public/app.html"])).toEqual([]);
  });

  it("flags src/security, src/tool-policy, src/auth and the protected-files manifest", () => {
    const changed = [
      "src/security/firewall.ts",
      "src/tool-policy/packs/arikernel-pack.ts",
      "src/auth/token.ts",
      "config/protected-files.json",
      "src/routes/memory.ts",
    ];
    expect(securitySensitiveChangedFiles(changed)).toEqual([
      "src/security/firewall.ts",
      "src/tool-policy/packs/arikernel-pack.ts",
      "src/auth/token.ts",
      "config/protected-files.json",
    ]);
  });

  it("matches Windows backslash paths from git status", () => {
    expect(securitySensitiveChangedFiles(["src\\security\\firewall.ts"])).toEqual(["src\\security\\firewall.ts"]);
  });

  it("does not match a sibling whose name merely starts with a guarded prefix", () => {
    // src/security-notes.ts is NOT inside src/security/ — prefix match is on the dir.
    expect(securitySensitiveChangedFiles(["src/security-notes.ts", "src/authority.ts"])).toEqual([]);
  });
});
