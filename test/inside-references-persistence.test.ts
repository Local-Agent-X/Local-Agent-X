/**
 * Data-continuity lock for inside-references persistence, added when the
 * module moved from its private atomicWrite/load/save copy onto the shared
 * json-store helper: same file (~/.lax/inside-references.json), same
 * pretty-printed envelope { references, pendingPhrases }, and a defined
 * reference survives a reload.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let InsideReferences: typeof import("../src/cognition/inside-references.js").InsideReferences;
let tmpRoot: string;
let prevDataDir: string | undefined;

beforeAll(async () => {
  // inside-references.ts snaps its store path from LAX_DATA_DIR at module
  // load — point it at a tempdir BEFORE the (dynamic) import.
  prevDataDir = process.env.LAX_DATA_DIR;
  tmpRoot = mkdtempSync(join(tmpdir(), "lax-inside-refs-test-"));
  process.env.LAX_DATA_DIR = tmpRoot;
  ({ InsideReferences } = await import("../src/cognition/inside-references.js"));
});

afterAll(() => {
  if (prevDataDir === undefined) delete process.env.LAX_DATA_DIR;
  else process.env.LAX_DATA_DIR = prevDataDir;
  rmSync(tmpRoot, { recursive: true, force: true });
});

describe("InsideReferences persistence", () => {
  it("writes the same file, envelope, and pretty format; round-trips a defined reference", () => {
    const refs = InsideReferences.getInstance();
    refs.defineReference("the thing", "deploying to prod", "release chat", "session-1");

    // Same on-disk location and envelope as before the json-store migration.
    const file = join(tmpRoot, "inside-references.json");
    const raw = readFileSync(file, "utf-8");
    expect(raw).toBe(JSON.stringify(JSON.parse(raw), null, 2)); // pretty-printed
    const parsed = JSON.parse(raw);
    expect(Array.isArray(parsed.references)).toBe(true);
    expect(Array.isArray(parsed.pendingPhrases)).toBe(true);
    expect(parsed.references[0].phrase).toBe("the thing");

    // Reads go through the store, so the meaning resolves from disk.
    const resolved = refs.resolveReference("the thing");
    expect(resolved?.means).toBe("deploying to prod");
  });
});
