import { describe, it, expect, afterAll } from "vitest";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// growth-tracker-store and associative-recall/types both bind their STORE_FILE =
// join(getLaxDir(), …) at import, so isolate the data dir to a fresh (empty) temp
// directory BEFORE the dynamic imports below (top-level await runs at file eval).
const prevLaxDir = process.env.LAX_DATA_DIR;
const tmp = mkdtempSync(join(tmpdir(), "lax-orphaned-halves-"));
process.env.LAX_DATA_DIR = tmp;
afterAll(() => {
  if (prevLaxDir === undefined) delete process.env.LAX_DATA_DIR;
  else process.env.LAX_DATA_DIR = prevLaxDir;
  rmSync(tmp, { recursive: true, force: true });
});

const { GrowthTracker } = await import("./growth-tracker.js");
const { AssociativeMemory } = await import("./associative-recall/index.js");

// AM-6: several cognitive subsystems are orphaned halves — their write/create
// side has zero callers, so the store stays permanently empty, yet the read side
// still runs every scheduled turn. The read side must produce NOTHING (no
// placeholder signal, no wasted persistence) while its store is empty.

describe("AM-6 growth-tracker: empty store emits no placeholder signal", () => {
  it("returns no signal instead of injecting 'haven't tracked any skills yet'", () => {
    const signals = GrowthTracker.getInstance().signalsFor();
    // Pre-fix: getGrowthSummary() returned the ~50-char placeholder, which is
    // longer than the length>10 gate, so a growth signal was injected here.
    expect(signals).toEqual([]);
    for (const s of signals) {
      expect(s.signal).not.toContain("haven't tracked any skills yet");
    }
  });
});

describe("AM-6 associative-recall: read on an empty store does not persist", () => {
  it("signalsFor() over empty nodes yields nothing and writes no store file", () => {
    const storeFile = join(tmp, "associative-memory.json");
    // Constructing the singleton only loads (never writes) the store.
    const signals = AssociativeMemory.getInstance().signalsFor(
      "a reasonably long message that should trigger recall processing",
    );
    // Pre-fix: recall() called saveStore() unconditionally, materializing the
    // store file on every pure read even though 0 nodes exist to recall.
    expect(signals).toEqual([]);
    expect(existsSync(storeFile)).toBe(false);
  });
});
