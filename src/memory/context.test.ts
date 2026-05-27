/**
 * Regression tests for the <core_memory> "still fresh" salience tag.
 *
 * Bug: the freshness window check and the displayed date both keyed off
 * `lastUpdated`, which `reinforceFacts()` bumps every time the entity is
 * mentioned. So an old biographical event (e.g. "Rex died on March 1") would
 * re-render as today's date with " — still fresh" the next time the user
 * said "Rex" months later. The fix anchors both on `timestamp` (creation
 * time, immutable) instead of `lastUpdated`.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MemoryIndex } from "../memory.js";
import { buildContextBlock } from "./context.js";

const DAY_MS = 24 * 60 * 60 * 1000;

let tempDir: string;
let memory: MemoryIndex;

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), "lax-ctx-"));
  mkdirSync(join(tempDir, "memory", "bank", "entities"), { recursive: true });
  mkdirSync(join(tempDir, "memory", "session-summaries"), { recursive: true });
  memory = new MemoryIndex(tempDir, { minScore: -1 });
});

afterEach(() => {
  try { memory.close(); } catch {}
  try { rmSync(tempDir, { recursive: true, force: true }); } catch {}
});

// Helper: insert a fact and then force its timestamp/last_updated columns to
// arbitrary epoch-ms values. rememberFact stamps both with Date.now(); for
// these tests we need to simulate "fact created N days ago, optionally
// reinforced today."
function setFactClock(factId: number, timestamp: number, lastUpdated: number): void {
  const db = memory["db"];
  db.prepare("UPDATE facts SET timestamp = ?, last_updated = ? WHERE id = ?")
    .run(timestamp, lastUpdated, factId);
}

function extractCoreMemory(block: string): string {
  const m = block.match(/<core_memory>[\s\S]*?<\/core_memory>/);
  return m ? m[0] : "";
}

describe("<core_memory> 'still fresh' salience", () => {
  it("renders the creation date with no 'still fresh' suffix for an old, never-reinforced experience", async () => {
    const now = Date.now();
    const thirtyDaysAgo = now - 30 * DAY_MS;

    const r = memory.rememberFact("Rex the dog died", { kind: "experience", confidence: 1.0 });
    expect(r.ok).toBe(true);
    setFactClock(r.fact!.id!, thirtyDaysAgo, thirtyDaysAgo);

    const block = await buildContextBlock(memory, { skipDailyLog: true });
    const core = extractCoreMemory(block);

    const expectedDate = new Date(thirtyDaysAgo).toISOString().slice(0, 10);
    expect(core).toContain(`${expectedDate}: Rex the dog died`);
    expect(core).not.toContain("still fresh");
  });

  it("flags a recently-created, never-reinforced experience as 'still fresh'", async () => {
    const now = Date.now();
    const threeDaysAgo = now - 3 * DAY_MS;

    const r = memory.rememberFact("Started Calenbella build", { kind: "experience", confidence: 1.0 });
    expect(r.ok).toBe(true);
    setFactClock(r.fact!.id!, threeDaysAgo, threeDaysAgo);

    const block = await buildContextBlock(memory, { skipDailyLog: true });
    const core = extractCoreMemory(block);

    const expectedDate = new Date(threeDaysAgo).toISOString().slice(0, 10);
    expect(core).toContain(`${expectedDate}: Started Calenbella build`);
    expect(core).toContain("still fresh");
  });

  // THE BUG: a 30-day-old fact reinforced today should keep its old creation
  // date and stay out of the freshness window. Before the fix this rendered
  // today's date + "still fresh" because both signals used last_updated.
  it("does NOT flag an old experience as 'still fresh' when only last_updated was bumped (the bug)", async () => {
    const now = Date.now();
    const thirtyDaysAgo = now - 30 * DAY_MS;
    const todayMs = now;

    const r = memory.rememberFact("Rex the dog died", { kind: "experience", confidence: 1.0 });
    expect(r.ok).toBe(true);
    // Simulate: created 30 days ago, reinforced (last_updated bumped) today.
    setFactClock(r.fact!.id!, thirtyDaysAgo, todayMs);

    const block = await buildContextBlock(memory, { skipDailyLog: true });
    const core = extractCoreMemory(block);

    const oldDate = new Date(thirtyDaysAgo).toISOString().slice(0, 10);
    const todayDate = new Date(todayMs).toISOString().slice(0, 10);
    expect(core).toContain(`${oldDate}: Rex the dog died`);
    expect(core).not.toContain(`${todayDate}: Rex the dog died`);
    expect(core).not.toContain("still fresh");
  });

  it("does not add a date prefix or 'still fresh' suffix to non-experience kinds", async () => {
    const now = Date.now();

    const r = memory.rememberFact("prefers oat milk", { kind: "opinion", confidence: 1.0 });
    expect(r.ok).toBe(true);
    setFactClock(r.fact!.id!, now, now);

    const block = await buildContextBlock(memory, { skipDailyLog: true });
    const core = extractCoreMemory(block);

    expect(core).toContain("prefers oat milk");
    const todayDate = new Date(now).toISOString().slice(0, 10);
    expect(core).not.toContain(`${todayDate}: prefers oat milk`);
    expect(core).not.toContain("still fresh");
  });
});
