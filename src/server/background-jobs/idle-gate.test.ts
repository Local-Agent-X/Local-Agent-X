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

describe("isForegroundBusy (SV-9 background-lane idle gate)", () => {
  const now = 1_000_000_000_000;
  const threshold = 90_000;

  it("reports BUSY when a session was written within the threshold (job suppressed)", () => {
    const recent = now - 5_000; // 5s ago — mid-conversation
    expect(isForegroundBusy(store([recent]), threshold, now)).toBe(true);
  });

  it("reports IDLE once every session is older than the threshold (job runs)", () => {
    const stale = now - 10 * 60 * 1000; // 10min ago
    expect(isForegroundBusy(store([stale]), threshold, now)).toBe(false);
  });

  it("uses the MOST-RECENT session, not an arbitrary one", () => {
    const stale = now - 10 * 60 * 1000;
    const fresh = now - 1_000;
    // A stale session listed alongside a fresh one must still read as BUSY.
    expect(isForegroundBusy(store([stale, fresh]), threshold, now)).toBe(true);
  });

  it("treats an empty session list as idle", () => {
    expect(isForegroundBusy(store([]), threshold, now)).toBe(false);
  });

  it("honours the boundary: exactly threshold-old counts as idle", () => {
    expect(isForegroundBusy(store([now - threshold]), threshold, now)).toBe(false);
  });

  it("reads a non-negative default threshold from env", () => {
    expect(readBgIdleThresholdMs()).toBeGreaterThanOrEqual(0);
  });
});
