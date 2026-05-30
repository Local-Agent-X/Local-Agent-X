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
import { changedFilesTouchDeps } from "../src/agency/worktree.js";

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
