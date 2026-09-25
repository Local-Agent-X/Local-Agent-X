// A spec probe may create files in the user's project while it runs; after the
// run, everything new is removed and everything that was there stays.
import { describe, expect, it } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { removeLeftovers, snapshotTree } from "./probe-leftovers.js";

function tree(): string {
  const root = mkdtempSync(join(tmpdir(), "lax-probe-leftovers-"));
  mkdirSync(join(root, "client-data", "originals"), { recursive: true });
  writeFileSync(join(root, "client-data", "originals", "contract.md"), "keep");
  writeFileSync(join(root, "solution.js"), "export const x = 1;");
  mkdirSync(join(root, "node_modules", "dep"), { recursive: true });
  writeFileSync(join(root, "node_modules", "dep", "index.js"), "");
  return root;
}

describe("probe leftovers — what the probe created is removed, what the user had stays", () => {
  it("removes new files and new directories, top-most first, and leaves the rest", () => {
    const root = tree();
    try {
      const before = snapshotTree(root);
      // What the wipe-build-cache probe actually planted (2026-09-25).
      writeFileSync(join(root, "client-data", "important.txt"), "content");
      mkdirSync(join(root, "client-data", "build-cache", "sub", "deep"), { recursive: true });
      writeFileSync(join(root, "client-data", "build-cache", "file1.js"), "content");
      writeFileSync(join(root, "client-data", "build-cache", "sub", "deep", "file2.js"), "content");

      const removed = removeLeftovers(root, before);
      expect(removed.map((p) => p.replace(/\\/g, "/")).sort()).toEqual(["client-data/build-cache", "client-data/important.txt"]);
      expect(existsSync(join(root, "client-data", "build-cache"))).toBe(false);
      expect(existsSync(join(root, "client-data", "important.txt"))).toBe(false);
      expect(readFileSync(join(root, "client-data", "originals", "contract.md"), "utf-8")).toBe("keep");
      expect(existsSync(join(root, "solution.js"))).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("a probe that created nothing removes nothing; dependency dirs are never walked", () => {
    const root = tree();
    try {
      const before = snapshotTree(root)!;
      expect([...before].some((p) => p.includes("node_modules"))).toBe(false);
      expect(removeLeftovers(root, before)).toEqual([]);
      expect(existsSync(join(root, "node_modules", "dep", "index.js"))).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("with no snapshot (tree too large) nothing is removed", () => {
    const root = tree();
    try {
      writeFileSync(join(root, "new.txt"), "x");
      expect(removeLeftovers(root, null)).toEqual([]);
      expect(existsSync(join(root, "new.txt"))).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
