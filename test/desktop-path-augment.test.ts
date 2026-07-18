import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, delimiter } from "node:path";
import { afterAll } from "vitest";
import { mergeAugmentedPath, portableNodeDirs } from "../desktop/src/path-augment";

// Regression: the in-app Node upgrade unpacks a portable node under
// %LOCALAPPDATA%\LocalAgentX\node-v* — but the desktop's PATH builder joined
// with a hardcoded ":" and never knew that dir, so the post-upgrade recheck
// reported "node still missing" after every SUCCESSFUL install and the boot
// gate looped forever. These tests pin the two behaviors that close the loop:
// platform-delimiter merging, and discovery of the freshly-installed dir.

const roots: string[] = [];
function tempRoot(): string {
  const r = mkdtempSync(join(tmpdir(), "lax-portable-node-"));
  roots.push(r);
  return r;
}
afterAll(() => { for (const r of roots) rmSync(r, { recursive: true, force: true }); });

function fakeNodeDir(root: string, name: string, withExe = true): void {
  const d = join(root, name);
  mkdirSync(d, { recursive: true });
  if (withExe) writeFileSync(join(d, "node.exe"), "");
}

describe("portableNodeDirs", () => {
  it("finds portable node dirs, newest version first", () => {
    const root = tempRoot();
    fakeNodeDir(root, "node-v22.10.0-win-x64");
    fakeNodeDir(root, "node-v24.16.0-win-x64");
    fakeNodeDir(root, "node-v24.2.0-win-arm64");
    expect(portableNodeDirs(root)).toEqual([
      join(root, "node-v24.16.0-win-x64"),
      join(root, "node-v24.2.0-win-arm64"),
      join(root, "node-v22.10.0-win-x64"),
    ]);
  });

  it("skips dirs without node.exe and non-node dirs", () => {
    const root = tempRoot();
    fakeNodeDir(root, "node-v24.16.0-win-x64", false); // half-extracted
    fakeNodeDir(root, "PortableGit");                  // sibling install, no match
    fakeNodeDir(root, "node-v22.1.0-win-x64");
    expect(portableNodeDirs(root)).toEqual([join(root, "node-v22.1.0-win-x64")]);
  });

  it("returns [] for a missing root instead of throwing", () => {
    expect(portableNodeDirs(join(tempRoot(), "does-not-exist"))).toEqual([]);
  });
});

describe("mergeAugmentedPath", () => {
  it("prepends augments with the PLATFORM delimiter (not a hardcoded ':')", () => {
    const existing = ["existA", "existB"].join(delimiter);
    const merged = mergeAugmentedPath(["aug1", "aug2"], existing);
    expect(merged).toBe(["aug1", "aug2", "existA", "existB"].join(delimiter));
  });

  it("dedupes and drops empty segments", () => {
    const existing = ["aug1", "", "existA"].join(delimiter);
    const merged = mergeAugmentedPath(["aug1"], existing);
    expect(merged).toBe(["aug1", "existA"].join(delimiter));
  });

  it("tolerates an unset PATH", () => {
    expect(mergeAugmentedPath(["aug1"], undefined)).toBe("aug1");
  });
});
