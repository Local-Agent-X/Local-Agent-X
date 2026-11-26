// What `git worktree remove` leaves when a held file stops its delete: a folder
// with no `.git` that the recovery sweep could never classify, so it stayed in
// Temp for good (2.4 GB of them on 2026-11-25). The boot sweep now deletes such
// folders, and never reaches through a link or touches a worktree.
import { describe, it, expect } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { reapWorktreeRemnants } from "./worktree-boot-sweep.js";
import { removeTreeRetrying } from "../util/remove-tree.js";

function setUp() {
  const root = mkdtempSync(join(tmpdir(), "lax-remnants-"));
  const base = join(root, "lax-worktrees");
  const deps = join(root, "parent-node_modules");
  mkdirSync(join(deps, "react"), { recursive: true });
  writeFileSync(join(deps, "react", "index.js"), "the parent's real dependency");

  // A leftover: app files, and a node_modules junction into the parent's deps.
  const leftover = join(base, "autobuild-c1");
  mkdirSync(join(leftover, "src"), { recursive: true });
  writeFileSync(join(leftover, "src", "App.tsx"), "export {}");
  symlinkSync(deps, join(leftover, "node_modules"), "junction");
  // An empty leftover.
  mkdirSync(join(base, "autobuild-c3-2"));
  // A worktree (live or recoverable): the recovery sweep's, not this one's.
  const worktree = join(base, "autobuild-c5");
  mkdirSync(worktree);
  writeFileSync(join(worktree, ".git"), "gitdir: C:/somewhere/.git/worktrees/autobuild-c5");
  // A link at the top: never followed.
  symlinkSync(deps, join(base, "linked"), "junction");
  return { base, deps, leftover, worktree };
}

describe("reapWorktreeRemnants", () => {
  it("deletes folders of removed worktrees, unlinking junctions first, and leaves worktrees and links alone", async () => {
    const { base, deps, leftover, worktree } = setUp();
    const removed = await reapWorktreeRemnants(base);
    expect(removed.sort()).toEqual([leftover, join(base, "autobuild-c3-2")].sort());
    expect(existsSync(leftover)).toBe(false);
    expect(existsSync(join(deps, "react", "index.js"))).toBe(true);
    expect(existsSync(join(worktree, ".git"))).toBe(true);
    expect(existsSync(join(base, "linked"))).toBe(true);
  });

  it("does nothing when the folder does not exist", async () => {
    expect(await reapWorktreeRemnants(join(tmpdir(), "lax-no-such-base-folder"))).toEqual([]);
  });
});

describe("removeTreeRetrying", () => {
  it("deletes a tree and says it is gone; a path already gone is gone", async () => {
    const dir = mkdtempSync(join(tmpdir(), "lax-remove-"));
    mkdirSync(join(dir, "a", "b"), { recursive: true });
    writeFileSync(join(dir, "a", "b", "c.txt"), "x");
    const gaveUp: string[] = [];
    expect(await removeTreeRetrying(dir, (r) => gaveUp.push(r))).toBe(true);
    expect(existsSync(dir)).toBe(false);
    expect(await removeTreeRetrying(dir, (r) => gaveUp.push(r))).toBe(true);
    expect(gaveUp).toEqual([]);
  });
});
