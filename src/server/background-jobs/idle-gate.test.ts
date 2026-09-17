import { describe, it, expect } from "vitest";
import { isForegroundBusy, readBgIdleThresholdMs } from "./index.js";

// SV-9: the LLM-heavy background lane (dream-check, memory-backfill,
// protocol-curator) must be suppressed while a turn is live, since they
// contend on the same provider key / rate-limit and the shared Ollama
// embedding CPU. Every turn bumps its session's updatedAt on save, so
// isForegroundBusy() gates on "a session was written within the threshold".

type Meta = { id: string; title: string; updatedAt: number; messageCount: number };
const store = (updatedAts: number[]) => ({
  list: (): Meta[] =>
    updatedAts.map((updatedAt, i) => ({ id: `s${i}`, title: "", updatedAt, messageCount: 0 })),
});

const noOps = () => [];

describe("isForegroundBusy (SV-9 background-lane idle gate)", () => {
  const now = 1_000_000_000_000;
  const threshold = 90_000;

  it("reports BUSY when a session was written within the threshold (job suppressed)", () => {
    const recent = now - 5_000; // 5s ago — mid-conversation
    expect(isForegroundBusy(store([recent]), threshold, now, noOps)).toBe(true);
  });

  it("reports IDLE once every session is older than the threshold (job runs)", () => {
    const stale = now - 10 * 60 * 1000; // 10min ago
    expect(isForegroundBusy(store([stale]), threshold, now, noOps)).toBe(false);
  });

  it("uses the MOST-RECENT session, not an arbitrary one", () => {
    const stale = now - 10 * 60 * 1000;
    const fresh = now - 1_000;
    // A stale session listed alongside a fresh one must still read as BUSY.
    expect(isForegroundBusy(store([stale, fresh]), threshold, now, noOps)).toBe(true);
  });

  it("treats an empty session list as idle", () => {
    expect(isForegroundBusy(store([]), threshold, now, noOps)).toBe(false);
  });

  it("honours the boundary: exactly threshold-old counts as idle", () => {
    expect(isForegroundBusy(store([now - threshold]), threshold, now, noOps)).toBe(false);
  });

  it("reads a non-negative default threshold from env", () => {
    expect(readBgIdleThresholdMs()).toBeGreaterThanOrEqual(0);
  });
});

describe("isForegroundBusy sees a turn that is still running", () => {
  // Sessions are saved when a turn ends. A local-model turn running for
  // minutes left no recent write, and skill-review took the GPU mid-turn.
  const now = 1_000_000_000_000;
  const stale = store([now - 10 * 60 * 1000]);
  const ops = (...rows: Array<{ lane: string | null; state: string }>) => () => rows;

  it("is BUSY while an interactive op is running, even with no recent session write", () => {
    expect(isForegroundBusy(stale, 90_000, now, ops({ lane: "interactive", state: "running" }))).toBe(true);
    expect(isForegroundBusy(stale, 90_000, now, ops({ lane: "agent", state: "queued" }))).toBe(true);
  });

  it("ignores background ops, so background work never blocks itself", () => {
    expect(isForegroundBusy(stale, 90_000, now, ops({ lane: "background", state: "running" }))).toBe(false);
  });

  it("ignores an op paused on an approval: it holds no model", () => {
    expect(isForegroundBusy(stale, 90_000, now, ops({ lane: "interactive", state: "paused" }))).toBe(false);
  });
});
