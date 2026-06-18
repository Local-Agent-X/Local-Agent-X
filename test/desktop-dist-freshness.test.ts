// Regression: every update touching desktop/src forced a double boot —
// reconcile rebuilt desktop/dist and relaunched even when a gated update had
// already pre-built it. The fix routes that decision through desktopDistIsFresh
// (mtime: dist newer than every src .ts), so reconcile skips the rebuild AND
// the relaunch when the loaded main process is already current. The dangerous
// direction is a FALSE-fresh: it would skip a real rebuild and boot stale
// main-process code — so the boundary is pinned both ways here against real
// files and explicit mtimes (no mocks; the bug lives in the mtime walk).
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, utimesSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { serverDistIsFresh, desktopDistIsFresh } from "../desktop/src/dist-freshness";

const OLD = new Date("2026-01-01T00:00:00Z");
const NEW = new Date("2026-01-01T01:00:00Z");

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "lax-freshness-"));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function writeAt(path: string, time: Date): void {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, "x");
  utimesSync(path, time, time);
}

describe("desktopDistIsFresh", () => {
  const distMain = () => join(root, "desktop", "dist", "main.js");
  const src = (...p: string[]) => join(root, "desktop", "src", ...p);

  it("is fresh when dist/main.js is newer than every src .ts", () => {
    writeAt(src("main.ts"), OLD);
    writeAt(src("ipc", "handlers.ts"), OLD);
    writeAt(distMain(), NEW);
    expect(desktopDistIsFresh(root)).toBe(true);
  });

  it("is STALE when any src .ts (even nested) is newer than dist — the relaunch case", () => {
    writeAt(src("main.ts"), OLD);
    writeAt(distMain(), NEW);
    writeAt(src("ipc", "handlers.ts"), new Date("2026-01-01T02:00:00Z"));
    expect(desktopDistIsFresh(root)).toBe(false);
  });

  it("is stale when dist/main.js is missing", () => {
    writeAt(src("main.ts"), OLD);
    expect(desktopDistIsFresh(root)).toBe(false);
  });

  it("ignores non-.ts files newer than dist", () => {
    writeAt(src("main.ts"), OLD);
    writeAt(distMain(), NEW);
    writeAt(src("notes.md"), new Date("2026-01-01T03:00:00Z"));
    expect(desktopDistIsFresh(root)).toBe(true);
  });
});

describe("serverDistIsFresh (shared walk did not regress in the refactor)", () => {
  it("fresh vs stale by dist/index.js mtime", () => {
    writeAt(join(root, "src", "index.ts"), OLD);
    writeAt(join(root, "dist", "index.js"), NEW);
    expect(serverDistIsFresh(root)).toBe(true);

    utimesSync(join(root, "src", "index.ts"), new Date("2026-01-01T04:00:00Z"), new Date("2026-01-01T04:00:00Z"));
    expect(serverDistIsFresh(root)).toBe(false);
  });
});
