import { describe, it, expect, afterAll } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { UpcomingEvent } from "./types.js";

// persistence.ts binds STORE_FILE = join(getLaxDir(), …) at import, so isolate
// the data dir BEFORE the dynamic import below (top-level await runs at eval).
const prevLaxDir = process.env.LAX_DATA_DIR;
const tmp = mkdtempSync(join(tmpdir(), "lax-anticipatory-persist-"));
process.env.LAX_DATA_DIR = tmp;
afterAll(() => {
  if (prevLaxDir === undefined) delete process.env.LAX_DATA_DIR;
  else process.env.LAX_DATA_DIR = prevLaxDir;
  rmSync(tmp, { recursive: true, force: true });
});

const { loadStore, saveStore } = await import("./persistence.js");

function event(i: number, date: string): UpcomingEvent {
  return {
    id: `e${i}`,
    event: `event ${i}`,
    date,
    importance: "medium",
    detectedAt: 0,
    sessionId: "s1",
    followedUp: false,
  };
}

// Data-continuity lock for the json-store migration: same file name, same
// pretty-printed on-disk format, same sort-by-date-then-head cap semantics.
describe("anticipatory-care persistence", () => {
  it("round-trips through ~/.lax/upcoming-events.json as pretty JSON", () => {
    saveStore({ events: [event(1, "2026-07-20")] });

    const file = join(tmp, "upcoming-events.json");
    const raw = readFileSync(file, "utf-8");
    // Pretty format (2-space indent) — installed stores must stay readable
    // by older builds byte-for-byte-compatibly.
    expect(raw).toBe(JSON.stringify({ events: [event(1, "2026-07-20")] }, null, 2));

    expect(loadStore().events.map((e) => e.id)).toEqual(["e1"]);
  });

  it("caps at 500 events keeping the NEWEST by date, not by insertion order", () => {
    // Oldest dates appended last, so a positional tail-cap would keep the
    // wrong entries — the cap must sort by date descending first.
    const events: UpcomingEvent[] = [];
    for (let i = 0; i < 501; i++) {
      const day = new Date(Date.UTC(2020, 0, 1) + (501 - i) * 86400000);
      events.push(event(i, day.toISOString()));
    }
    const store = { events };
    saveStore(store);

    // In-memory object capped in place, like the old private saveStore.
    expect(store.events.length).toBe(500);
    const persisted = loadStore().events;
    expect(persisted.length).toBe(500);
    // e500 has the OLDEST date and must be the one dropped.
    expect(persisted.some((e) => e.id === "e500")).toBe(false);
    expect(persisted[0].id).toBe("e0"); // newest date first after the cap sort
  });
});
