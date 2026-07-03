import { describe, it, expect, beforeAll } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// AM-9: the in-memory footprints of the orchestrator must stay bounded for the
// whole process lifetime, matching the on-disk caps. These tests prove the two
// skeptic breaks are closed and FAIL on the still-broken variants:
//   • state.ts: the per-session cadence Map must LRU-evict past MAX_CADENCE_SESSIONS.
//   • emotional-memory.ts: recordEmotion() must trim the in-memory records list,
//     not just the slice() copy it writes to disk.
//
// Both LAX modules resolve their data dir at import time, and EmotionalMemory is
// a load-time singleton, so we point LAX_DATA_DIR at a throwaway dir and load
// them dynamically after the env is set — no real ~/.lax pollution.

let getSessionCadence: typeof import("./state.js").getSessionCadence;
let sessionCadenceCount: typeof import("./state.js").sessionCadenceCount;
let MAX_CADENCE_SESSIONS: number;
let EmotionalMemory: typeof import("../emotional-memory.js").EmotionalMemory;
let processMessageImpl: typeof import("./process-message-impl.js").processMessageImpl;

beforeAll(async () => {
  process.env.LAX_DATA_DIR = mkdtempSync(join(tmpdir(), "am9-bounds-"));
  const state = await import("./state.js");
  getSessionCadence = state.getSessionCadence;
  sessionCadenceCount = state.sessionCadenceCount;
  MAX_CADENCE_SESSIONS = state.MAX_CADENCE_SESSIONS;
  ({ EmotionalMemory } = await import("../emotional-memory.js"));
  ({ processMessageImpl } = await import("./process-message-impl.js"));
});

function inputFor(sessionId: string, message: string): import("./types.js").OrchestratorInput {
  return { message, sessionId, sessionMessages: [], timeOfDay: 12, dayOfWeek: 3 };
}

describe("state.ts per-session cadence — LRU bound (AM-9 symptom a)", () => {
  it("evicts the oldest session past MAX_CADENCE_SESSIONS and never grows past the cap", () => {
    const overflow = 50;
    const total = MAX_CADENCE_SESSIONS + overflow;

    // Insert `total` distinct sessions, each with an observable, non-zero
    // counter so we can tell an evicted (fresh-zero) session from a survivor.
    for (let i = 0; i < total; i++) {
      const c = getSessionCadence(`s${i}`);
      c.messageCount = i + 1; // s0 → 1, sN → N+1 (all non-zero)
      // The map must be bounded on every insert, not just at the end.
      expect(sessionCadenceCount()).toBeLessThanOrEqual(MAX_CADENCE_SESSIONS);
    }

    // At capacity exactly.
    expect(sessionCadenceCount()).toBe(MAX_CADENCE_SESSIONS);

    // The most-recently-inserted session survived with its counter intact —
    // proves we're actually tracking state, not resetting everything.
    const survivor = getSessionCadence(`s${total - 1}`);
    expect(survivor.messageCount).toBe(total); // (total-1)+1

    // The oldest session (s0) was evicted: re-reading it hands back a FRESH
    // zero-state entry. On the pre-fix (unbounded) map, s0 would still carry
    // its original messageCount of 1, so this assertion would fail.
    const oldest = getSessionCadence("s0");
    expect(oldest.messageCount).toBe(0);
  });
});

describe("emotional-memory.ts recordEmotion — in-memory bound (AM-9 symptom c)", () => {
  it("keeps the in-memory records list bounded past the FIFO cap", () => {
    const MAX_ENTRIES = 1000; // must mirror emotional-memory.ts
    const recordCount = MAX_ENTRIES + 100;

    for (let i = 0; i < recordCount; i++) {
      EmotionalMemory.recordEmotion(
        `sess-${i}`,
        { primary: "calm", confidence: 0.5, signals: [] },
        `context ${i}`,
      );
    }

    // totalRecords reflects the length of the in-memory list. Pre-fix,
    // recordEmotion only trimmed the disk slice and left this.records growing
    // unbounded, so this would be recordCount (1100), not the cap.
    const total = EmotionalMemory.getEmotionalProfile().totalRecords;
    expect(total).toBeLessThanOrEqual(MAX_ENTRIES);
    expect(total).toBeLessThan(recordCount);
  });
});

describe("processMessageImpl wires cadence per-session (AM-9 symptom a, live path)", () => {
  it("counts each session's messages into its OWN cadence, not a shared global", async () => {
    // Two messages on session A, one on session B, through the real orchestrator
    // entrypoint. Pre-wiring, the caller incremented only the process-global
    // orchestratorState.messageCount and never touched getSessionCadence, so the
    // per-session counters below would both be 0 and this test would FAIL.
    await processMessageImpl(inputFor("wire-A", "hello from A"));
    await processMessageImpl(inputFor("wire-A", "second from A"));
    await processMessageImpl(inputFor("wire-B", "hello from B"));

    expect(getSessionCadence("wire-A").messageCount).toBe(2);
    expect(getSessionCadence("wire-B").messageCount).toBe(1);
  });
});
