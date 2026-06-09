// Stale-read guard core. Proves the freshness tracker distinguishes unseen,
// fresh, and stale files per session — the logic the run-sandboxed guard uses
// to decide whether an edit may proceed or must re-read first.

import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
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
});
