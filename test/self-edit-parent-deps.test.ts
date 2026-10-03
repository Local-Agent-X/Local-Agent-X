/**
 * Tests for the parent node_modules integrity guard (#2).
 *
 * fingerprintParentDeps cheaply detects whether the parent's node_modules
 * changed during a self_edit run (a subprocess that disobeyed the no-install
 * instruction and wrote through the worktree junction). We assert it is stable
 * when nothing changes, trips when the package set or npm's install record
 * changes, and returns null when there's nothing to guard.
 *
 * restoreParentDeps runs a real `npm ci`, so its test uses a zero-dependency
 * lockfile: no registry traffic, but the root lifecycle scripts still run.
 */

import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fingerprintParentDeps, restoreParentDeps } from "../src/self-edit/parent-deps-guard.js";

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

describe("restoreParentDeps", () => {
  const PROBE_SECRET_KEY = "LAX_SCRUB_PROBE_API_KEY";
  const PROBE_SECRET_VALUE = "sk-scrub-probe-6f1d0c2a9b8e7d3c";

  it("runs npm ci lifecycle scripts without a credential from the server env", () => {
    const root = mkdtempSync(join(tmpdir(), "lax-deps-restore-"));
    try {
      writeFileSync(join(root, "dump-env.cjs"), `require("node:fs").writeFileSync("env.json", JSON.stringify(process.env));\n`);
      writeFileSync(join(root, "package.json"), JSON.stringify({
        name: "restore-fixture", version: "0.0.0", private: true, scripts: { postinstall: "node dump-env.cjs" },
      }));
      writeFileSync(join(root, "package-lock.json"), JSON.stringify({
        name: "restore-fixture", version: "0.0.0", lockfileVersion: 3, requires: true,
        packages: { "": { name: "restore-fixture", version: "0.0.0" } },
      }));
      process.env[PROBE_SECRET_KEY] = PROBE_SECRET_VALUE;
      let r: ReturnType<typeof restoreParentDeps>;
      try { r = restoreParentDeps(root); } finally { delete process.env[PROBE_SECRET_KEY]; }

      expect(r).toEqual({ ok: true, detail: "npm ci restored parent node_modules" });
      const childEnv = JSON.parse(readFileSync(join(root, "env.json"), "utf-8")) as Record<string, string>;
      expect(childEnv).not.toHaveProperty(PROBE_SECRET_KEY);
      expect(JSON.stringify(childEnv)).not.toContain(PROBE_SECRET_VALUE);
    } finally {
      rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  }, 120_000);
});
