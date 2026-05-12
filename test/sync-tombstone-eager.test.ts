/**
 * Eager workspace-app tombstones — verify that tombstoneAppEagerly
 * writes a synced tombstone immediately (no push needed) so a
 * "delete then restart then pull" sequence doesn't resurrect the app.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { tombstoneAppEagerly } from "../src/sync/tombstones.js";

let syncDir: string;

beforeEach(() => {
  syncDir = mkdtempSync(join(tmpdir(), "tomb-eager-"));
});

afterEach(() => {
  try { rmSync(syncDir, { recursive: true, force: true }); } catch { /* best-effort */ }
});

describe("tombstoneAppEagerly", () => {
  it("writes a synced tombstone file with the expected shape", () => {
    tombstoneAppEagerly(syncDir, "mygroomtime");
    const file = join(syncDir, ".tombstones", "mygroomtime.json");
    expect(existsSync(file)).toBe(true);
    const parsed = JSON.parse(readFileSync(file, "utf-8"));
    expect(parsed.name).toBe("mygroomtime");
    expect(typeof parsed.deletedAt).toBe("string");
    expect(typeof parsed.deletedBy).toBe("string");
  });

  it("is idempotent — second call overwrites with current timestamp, no throw", () => {
    tombstoneAppEagerly(syncDir, "x");
    expect(() => tombstoneAppEagerly(syncDir, "x")).not.toThrow();
    const file = join(syncDir, ".tombstones", "x.json");
    expect(existsSync(file)).toBe(true);
  });

  it("creates the .tombstones dir if missing", () => {
    expect(existsSync(join(syncDir, ".tombstones"))).toBe(false);
    tombstoneAppEagerly(syncDir, "first");
    expect(existsSync(join(syncDir, ".tombstones"))).toBe(true);
  });
});
