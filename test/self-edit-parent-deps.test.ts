/**
 * Tests for the parent node_modules integrity guard (#2).
 *
 * fingerprintParentDeps cheaply detects whether the parent's node_modules
 * changed during a self_edit run (a subprocess that disobeyed the no-install
 * instruction and wrote through the worktree junction). We assert it is stable
 * when nothing changes, trips when the package set or npm's install record
 * changes, and returns null when there's nothing to guard.
 *
 * restoreParentDeps actually runs `npm ci`, so it is exercised end-to-end, not
 * here.
 */

import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fingerprintParentDeps } from "../src/self-edit/parent-deps-guard.js";

function makeRepo(): string {
  const root = mkdtempSync(join(tmpdir(), "lax-deps-test-"));
  const nm = join(root, "node_modules");
  mkdirSync(nm, { recursive: true });
  mkdirSync(join(nm, "typescript"), { recursive: true });
  writeFileSync(join(nm, "typescript", "package.json"), "{}");
  writeFileSync(join(nm, ".package-lock.json"), JSON.stringify({ name: "x", lockfileVersion: 3 }));
  return root;
}

describe("fingerprintParentDeps", () => {
  it("returns null when there is no node_modules to guard", () => {
    const root = mkdtempSync(join(tmpdir(), "lax-deps-empty-"));
    expect(fingerprintParentDeps(root)).toBeNull();
  });

  it("is stable across calls when nothing changes", () => {
    const root = makeRepo();
    expect(fingerprintParentDeps(root)).toBe(fingerprintParentDeps(root));
  });

  it("changes when a top-level package is added (prune/install signal)", () => {
    const root = makeRepo();
    const before = fingerprintParentDeps(root);
    mkdirSync(join(root, "node_modules", "left-pad"), { recursive: true });
    expect(fingerprintParentDeps(root)).not.toBe(before);
  });

  it("changes when npm's install record (.package-lock.json) changes", () => {
    const root = makeRepo();
    const before = fingerprintParentDeps(root);
    writeFileSync(join(root, "node_modules", ".package-lock.json"), JSON.stringify({ name: "x", lockfileVersion: 3, mutated: true }));
    expect(fingerprintParentDeps(root)).not.toBe(before);
  });

  it("changes when a critical sentinel package is removed (prune)", () => {
    const root = makeRepo();
    const before = fingerprintParentDeps(root);
    rmSync(join(root, "node_modules", "typescript"), { recursive: true, force: true });
    expect(fingerprintParentDeps(root)).not.toBe(before);
  });
});
