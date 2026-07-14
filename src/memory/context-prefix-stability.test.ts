/**
 * Prefix-stability contract for buildContextBlock / buildContextBlockParts.
 *
 * The context block is injected into the SYSTEM prompt every request, so any
 * turn-to-turn churn in its leading bytes defeats provider prompt caching.
 * Contract under test:
 *   (a) the `stable` part is byte-identical across consecutive builds, even
 *       when reinforceFacts ran (and reshuffled hot-scores) in between and
 *       the daily log grew;
 *   (b) <current_datetime> is day-granularity only — no clock time;
 *   (c) volatile sections (<current_datetime>, <today_context>,
 *       <known_entities>) still render, and render LAST, and
 *       buildContextBlock === stable + volatile.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MemoryIndex } from "./index.js";
import { authorizeTestFactMutations } from "./test-promotion.test-helper.js";
import { buildContextBlock, buildContextBlockParts } from "./context.js";
import { createInternalMemoryContext } from "./promotion-gate.js";

const DAY_MS = 24 * 60 * 60 * 1000;

let tempDir: string;
let memory: MemoryIndex;

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), "lax-ctx-stab-"));
  mkdirSync(join(tempDir, "memory", "bank", "entities"), { recursive: true });
  mkdirSync(join(tempDir, "memory", "session-summaries"), { recursive: true });
  memory = new MemoryIndex(tempDir, { minScore: -1 });
  authorizeTestFactMutations(memory);
});

afterEach(() => {
  try { memory.close(); } catch {}
  try { rmSync(tempDir, { recursive: true, force: true }); } catch {}
});

function setFactClock(factId: number, timestamp: number, lastUpdated: number): void {
  memory["db"]
    .prepare("UPDATE facts SET timestamp = ?, last_updated = ? WHERE id = ?")
    .run(timestamp, lastUpdated, factId);
}

function appendLog(content: string, sessionId: string): void {
  memory.appendDailyLog(content, sessionId, "tool", createInternalMemoryContext(content, memory.getDailyLogPath(), "test"));
}

describe("context block prefix stability", () => {
  it("stable part is byte-identical across builds even when reinforceFacts ran between them", async () => {
    const now = Date.now();
    // An entity-tagged fact plus fillers; the entity mention in the user
    // message triggers reinforceFacts inside the first build, so by the
    // second build hot-score order has been reshuffled.
    const rA = memory.rememberFact("loves hiking @alex", { kind: "observation", confidence: 0.9 });
    expect(rA.ok).toBe(true);
    setFactClock(rA.fact!.id!, now - 20 * DAY_MS, now - 20 * DAY_MS);
    for (let i = 0; i < 5; i++) {
      const r = memory.rememberFact(`stable filler fact number ${i}`, { kind: "world", confidence: 0.8 });
      expect(r.ok).toBe(true);
      setFactClock(r.fact!.id!, now - i * 1000, now - i * 1000);
    }

    const opts = { userMessage: "what do you know about alex?", sessionId: "sess-stab" };
    const first = await buildContextBlockParts(memory, opts);
    // Extra churn between builds: explicit reinforcement + daily-log growth.
    memory.reinforceFacts([rA.fact!.id!]);
    appendLog("Background sync completed", "sess-stab");
    const second = await buildContextBlockParts(memory, opts);

    expect(first.stable.length).toBeGreaterThan(0);
    expect(second.stable).toBe(first.stable); // byte-identical prefix
    // The reinforced fact is still SELECTED into core_memory.
    expect(second.stable).toContain("loves hiking");
  });

  it("core_memory render order is pinned to fact id, not hot-score", async () => {
    const now = Date.now();
    const r1 = memory.rememberFact("first inserted fact", { kind: "world", confidence: 0.8 });
    const r2 = memory.rememberFact("second inserted fact", { kind: "world", confidence: 0.8 });
    expect(r1.ok && r2.ok).toBe(true);
    setFactClock(r1.fact!.id!, now - 10 * DAY_MS, now - 10 * DAY_MS);
    setFactClock(r2.fact!.id!, now, now);

    // Hot-score would put r2 first (fresher); id order keeps r1 first.
    const before = await buildContextBlockParts(memory, { skipDailyLog: true });
    expect(before.stable.indexOf("first inserted fact"))
      .toBeLessThan(before.stable.indexOf("second inserted fact"));

    // Reinforce r2 (bumps last_updated → hot-score) — bytes must not move.
    memory.reinforceFacts([r2.fact!.id!]);
    const after = await buildContextBlockParts(memory, { skipDailyLog: true });
    expect(after.stable).toBe(before.stable);
  });

  it("renders <current_datetime> at day granularity — no hours/minutes/seconds", async () => {
    const block = await buildContextBlock(memory, { skipDailyLog: true });
    const m = block.match(/<current_datetime>[\s\S]*?<\/current_datetime>/);
    expect(m).not.toBeNull();
    const dt = m![0];
    expect(dt).toMatch(/Today is /);
    expect(dt).toMatch(/ISO date: \d{4}-\d{2}-\d{2}\n/);
    expect(dt).toMatch(/Timezone: /);
    // No clock time in any form: HH:MM, H:MM AM, or an ISO time component.
    expect(dt).not.toMatch(/\d{1,2}:\d{2}/);
    expect(dt).not.toMatch(/T\d{2}/);
    expect(dt).not.toMatch(/\d\s*[AP]M\b/i); // no "3:05 PM"-style clock
  });

  it("volatile sections still render, render last, and concat equals buildContextBlock", async () => {
    const now = Date.now();
    const r = memory.rememberFact("loves hiking @alex", { kind: "observation", confidence: 0.9 });
    expect(r.ok).toBe(true);
    setFactClock(r.fact!.id!, now, now);
    appendLog("Background sync completed", "sess-vol");

    const opts = { userMessage: "tell me about alex", sessionId: "sess-vol" };
    const parts = await buildContextBlockParts(memory, opts);
    const block = await buildContextBlock(memory, opts);

    // Concatenation is the legacy single-string block.
    expect(parts.stable + parts.volatile).toBe(block);

    // Volatile sections live in the volatile tail, not the stable prefix.
    for (const tag of ["<current_datetime>", "<today_context>", "<known_entities>"]) {
      expect(parts.volatile).toContain(tag);
      expect(parts.stable).not.toContain(tag);
    }
    // Stable sections come first; every volatile section sits after them.
    const lastStable = Math.max(block.indexOf("<user_profile>"), block.indexOf("<core_memory>"));
    expect(lastStable).toBeGreaterThan(-1);
    for (const tag of ["<current_datetime>", "<today_context>", "<known_entities>"]) {
      expect(block.indexOf(tag)).toBeGreaterThan(lastStable);
    }
    // Envelope markers stay at the extremes.
    expect(block.trimStart().startsWith("--- MEMORY CONTEXT")).toBe(true);
    expect(block.trimEnd().endsWith("--- END MEMORY CONTEXT ---")).toBe(true);
  });

  describe("'still fresh' flag is local-day-quantized", () => {
    afterEach(() => vi.useRealTimers());

    it("does not flip within a calendar day, even across the raw 14-day ms boundary", async () => {
      // Anchor mid-day so t0 and t0+400ms share a local calendar day.
      const t0 = new Date("2026-07-13T12:00:00").getTime();
      vi.useFakeTimers();
      vi.setSystemTime(t0);

      // 150ms inside the raw 14-day window: an ms-precision comparison says
      // "fresh" at t0 and "not fresh" 400ms later — the churn under test.
      const r = memory.rememberFact("moved to Austin", { kind: "experience", confidence: 1.0 });
      expect(r.ok).toBe(true);
      const ts = t0 - 14 * DAY_MS + 150;
      setFactClock(r.fact!.id!, ts, ts);

      const first = await buildContextBlockParts(memory, { skipDailyLog: true });
      vi.setSystemTime(t0 + 400);
      const second = await buildContextBlockParts(memory, { skipDailyLog: true });

      expect(first.stable).toContain("moved to Austin");
      expect(second.stable).toBe(first.stable); // no intra-day flip
    });

    it("flips only on the local-day rollover (pins the day-granular semantics)", async () => {
      const t0 = new Date("2026-07-13T12:00:00").getTime();
      vi.useFakeTimers();
      vi.setSystemTime(t0);

      // 13 whole local days old → fresh today, 14 days old tomorrow.
      const r = memory.rememberFact("moved to Austin", { kind: "experience", confidence: 1.0 });
      expect(r.ok).toBe(true);
      const ts = t0 - 13 * DAY_MS;
      setFactClock(r.fact!.id!, ts, ts);

      const today = await buildContextBlockParts(memory, { skipDailyLog: true });
      expect(today.stable).toContain("moved to Austin — still fresh");

      vi.setSystemTime(t0 + DAY_MS); // next local day
      const tomorrow = await buildContextBlockParts(memory, { skipDailyLog: true });
      expect(tomorrow.stable).toContain("moved to Austin");
      expect(tomorrow.stable).not.toContain("still fresh");
    });
  });
});
