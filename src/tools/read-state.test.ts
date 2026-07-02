// Stale-read guard core. Proves the freshness tracker distinguishes unseen,
// fresh, and stale files per session — the logic the run-sandboxed guard uses
// to decide whether an edit may proceed or must re-read first.

import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { recordFileSeen, checkFreshness, forgetSessionReads } from "./read-state.js";

const dirs = new Set<string>();
afterEach(() => {
  for (const d of dirs) { try { rmSync(d, { recursive: true, force: true }); } catch { /* best effort */ } }
  dirs.clear();
});

function tmpFile(name: string, body: string): string {
  const dir = mkdtempSync(join(tmpdir(), "lax-rs-"));
  dirs.add(dir);
  const file = join(dir, name);
  writeFileSync(file, body, "utf-8");
  return file;
}

// Does this environment allow creating a dir junction/symlink (Windows dir
// junctions need no admin; CI without symlink privilege does)? Detected once so
// the junction regression skips cleanly instead of failing where unsupported.
function junctionSupported(): boolean {
  const base = mkdtempSync(join(tmpdir(), "lax-rs-probe-"));
  dirs.add(base);
  try { symlinkSync(join(base, "real"), join(base, "link"), "junction"); return true; }
  catch { return false; }
}
const JUNCTIONS_OK = junctionSupported();

describe("read-state freshness", () => {
  it("reports unseen until the session records the file", () => {
    const file = tmpFile("a.txt", "hello\n");
    expect(checkFreshness("s1", file)).toBe("unseen");
    recordFileSeen("s1", file);
    expect(checkFreshness("s1", file)).toBe("ok");
  });

  it("reports stale once the file changes on disk after being seen", () => {
    const file = tmpFile("b.txt", "v1\n");
    recordFileSeen("s1", file);
    expect(checkFreshness("s1", file)).toBe("ok");
    writeFileSync(file, "v2\n", "utf-8");
    expect(checkFreshness("s1", file)).toBe("stale");
  });

  it("scopes tracking per session", () => {
    const file = tmpFile("c.txt", "x\n");
    recordFileSeen("s1", file);
    expect(checkFreshness("s1", file)).toBe("ok");
    expect(checkFreshness("s2", file)).toBe("unseen");
  });

  it("forgets a session on demand", () => {
    const file = tmpFile("d.txt", "x\n");
    recordFileSeen("s1", file);
    forgetSessionReads("s1");
    expect(checkFreshness("s1", file)).toBe("unseen");
  });

  // Regression (2026-07-02, food-truck chunk 2): read resolved to the workspace
  // junction spelling and the later edit to its target — same file, two keys —
  // so the stale-read guard blocked an edit on a file the worker had just read.
  it.skipIf(!JUNCTIONS_OK)("treats a file seen via a junction as the same file when edited via the real path", () => {
    const realDir = mkdtempSync(join(tmpdir(), "lax-rs-real-"));
    dirs.add(realDir);
    const realFile = join(realDir, "page.tsx");
    writeFileSync(realFile, "export default 1\n", "utf-8");

    // A junction dir pointing at realDir — the same inode, a different spelling.
    const linkDir = join(mkdtempSync(join(tmpdir(), "lax-rs-link-")), "ws");
    dirs.add(join(linkDir, ".."));
    symlinkSync(realDir, linkDir, "junction");
    const viaJunction = join(linkDir, "page.tsx");

    // Read via the junction spelling, edit-check via the real spelling.
    recordFileSeen("s1", viaJunction);
    expect(checkFreshness("s1", realFile)).toBe("ok");

    // And the reverse direction — read real, check via junction.
    forgetSessionReads("s1");
    recordFileSeen("s1", realFile);
    expect(checkFreshness("s1", viaJunction)).toBe("ok");

    // A genuine post-read change is still caught through either spelling.
    writeFileSync(realFile, "export default 2\n", "utf-8");
    expect(checkFreshness("s1", viaJunction)).toBe("stale");
  });
});
