import { lstatSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { inside, pathChainChecker, safePathChain, safeRelative } from "./update-rollback-state.js";
import { CAN_CREATE_DIRECTORY_LINK } from "./symlink-capabilities.test-helper.js";

/** The walk safePathChain did before the checker: lstat and realpath every
 *  component on its own. The checker must give the same verdict for every path. */
function walkEveryComponent(base: string, relativePath: string): boolean {
  if (!safeRelative(relativePath) || !inside(base, resolve(base, relativePath))) return false;
  let current = resolve(base);
  for (const part of relativePath.split(/[\\/]/)) {
    current = resolve(current, part);
    try {
      const info = lstatSync(current);
      if (info.isSymbolicLink() || !inside(base, realpathSync(current))) return false;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") return false;
    }
  }
  return true;
}

const root = realpathSync(mkdtempSync(join(tmpdir(), "lax-path-chain-")));
afterAll(() => rmSync(root, { recursive: true, force: true }));

const PATHS = [
  join("a", "b", "file.txt"), join("a", "b"), join("a", "b", "missing", "deeper"), join("missing", "deeper"),
  join("a", "link"), join("a", "link", "x"), join("inner-link", "b", "file.txt"), join("a", "b", "file.txt", "child"),
  join("..", "outside"), join("a", "..", "a", "b"), "",
];

describe.skipIf(!CAN_CREATE_DIRECTORY_LINK)("pathChainChecker", () => {
  const linkType = process.platform === "win32" ? "junction" : "dir";
  const base = join(root, "base");
  const linkedBase = join(root, "via-link");
  mkdirSync(join(base, "a", "b"), { recursive: true });
  writeFileSync(join(base, "a", "b", "file.txt"), "x");
  mkdirSync(join(root, "outside"));
  symlinkSync(join(root, "outside"), join(base, "a", "link"), linkType);
  symlinkSync(join(base, "a"), join(base, "inner-link"), linkType);
  symlinkSync(base, linkedBase, linkType);

  for (const [label, at] of [["a plain base", base], ["a base reached through a link", linkedBase]] as const) {
    it(`gives the per-component walk's verdict for every path under ${label}`, () => {
      const expected = PATHS.map((path) => walkEveryComponent(at, path));
      expect(expected).toContain(false);
      expect(PATHS.map((path) => safePathChain(at, path))).toEqual(expected);
      // One checker held across the whole pass, in either order, and one seeded
      // with the real base, decide each path exactly as a fresh walk does.
      const shared = pathChainChecker(at);
      expect(PATHS.map((path) => shared(path))).toEqual(expected);
      const reversed = pathChainChecker(at);
      expect([...PATHS].reverse().map((path) => reversed(path)).reverse()).toEqual(expected);
      const seeded = pathChainChecker(at, realpathSync(at));
      expect(PATHS.map((path) => seeded(path))).toEqual(expected);
    });
  }

  it("refuses every path through a linked directory, not only the first one checked", () => {
    const check = pathChainChecker(base);
    expect(check(join("a", "link", "one"))).toBe(false);
    expect(check(join("a", "link", "two"))).toBe(false);
    expect(check(join("a", "b", "file.txt"))).toBe(true);
  });
});
