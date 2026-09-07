// F1 — the load-bearing property of the conversation prompt-cache fix under
// COMPACTION, which is the only regime where the 4.85M-write bug occurs.
//
// The turn loop never persists the compacted view: every turn rebuilds from
// readOpMessages and re-runs compactHistory, and safeSplitIndex advances by
// whatever the last turn appended. Before the summary-stability cache, that
// meant the summarizer saw a DIFFERENT head every turn and emitted DIFFERENT
// bytes at message index 0 every turn — the cached region diverged at index 0,
// so the Anthropic message-tier breakpoint could never hit, and one summarizer
// call burned per turn forever.
//
// Mutation check (this file must go red on the old code): delete the
// `reusableSummary` branch in compactHistory so every turn calls
// summarizeOldMessages on `messages.slice(0, splitIdx)`. The call count goes
// 1 → 3 and index 0 diverges on turn 2.
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../../context-manager/status.js", () => ({ getContextStatus: vi.fn() }));
vi.mock("../../context-manager/compaction.js", () => ({ summarizeOldMessages: vi.fn() }));
vi.mock("../../context-manager/resolve-transport.js", () => ({ resolveAnthropicTransport: () => "cli" }));

const loggerMock = vi.hoisted(() => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }));
vi.mock("../../logger.js", () => ({ createLogger: () => loggerMock }));

import { compactHistory } from "./compact-history.js";
import { clearSummaryCache } from "./compact-summary-cache.js";
import { getContextStatus } from "../../context-manager/status.js";
import { summarizeOldMessages } from "../../context-manager/compaction.js";
import type { CanonicalMessage } from "../contract-types.js";

const mockStatus = vi.mocked(getContextStatus);
const mockSummarize = vi.mocked(summarizeOldMessages);

const u = (id: string, text: string): CanonicalMessage => ({ messageId: id, role: "user", content: { text } });
const a = (id: string, text: string): CanonicalMessage => ({ messageId: id, role: "assistant", content: { text } });

const status = (percentage: number, shouldCompact: boolean) =>
  ({ usedTokens: 1, maxTokens: 1, percentage, level: "compact" as const, shouldCompact, forceCompact: false });

const MODEL = "claude-sonnet-4-6";
const OP = "op-stability";

// A long op past the threshold, growing by one assistant + one user row per
// turn — the ordinary continuation shape.
function historyAt(turn: number): CanonicalMessage[] {
  const msgs: CanonicalMessage[] = [u("u0", "ship the thing")];
  for (let i = 0; i < 10 + turn * 2; i++) {
    msgs.push(i % 2 === 0 ? a(`a${i}`, `step ${i}`) : u(`u${i + 1}`, `next ${i}`));
  }
  return msgs;
}

beforeEach(() => {
  mockStatus.mockReset();
  mockSummarize.mockReset();
  loggerMock.debug.mockReset();
  loggerMock.error.mockReset();
  clearSummaryCache();
  mockStatus.mockReturnValue(status(80, true));
  // Deterministic summarizer: its bytes are a pure function of the head it is
  // given, so a per-turn re-summarize is DETECTABLE at index 0.
  let n = 0;
  mockSummarize.mockImplementation(async (head) => `summary#${++n} of ${head.length} rows`);
});

describe("compactHistory — summary stability across consecutive compacted turns", () => {
  it("summarizes ONCE and keeps index 0 byte-identical over three compacted turns", async () => {
    const views: CanonicalMessage[][] = [];
    for (let turn = 0; turn < 3; turn++) {
      const out = await compactHistory(historyAt(turn), MODEL, null, OP);
      expect(out.compacted, `turn ${turn} must actually compact`).toBe(true);
      views.push(out.messages);
    }

    // Index 0 (the summary boundary row) is byte-identical turn over turn —
    // asserted FIRST so the mutation's first divergence is reported there.
    expect(JSON.stringify(views[1][0])).toBe(JSON.stringify(views[0][0]));
    expect(JSON.stringify(views[2][0])).toBe(JSON.stringify(views[1][0]));

    // The summarizer ran exactly once — turns 2 and 3 reused the pinned head.
    expect(mockSummarize).toHaveBeenCalledTimes(1);

    // …and the whole earlier view is a strict PREFIX of the later one: the
    // cached region only ever grows at the end, which is exactly what the
    // message-tier breakpoint needs.
    for (let t = 1; t < 3; t++) {
      expect(views[t].length).toBeGreaterThan(views[t - 1].length);
      for (let i = 0; i < views[t - 1].length; i++) {
        expect(JSON.stringify(views[t][i]), `turn ${t} diverged at index ${i}`)
          .toBe(JSON.stringify(views[t - 1][i]));
      }
    }
  });

  it("re-summarizes once the summarized head has grown past the refresh threshold", async () => {
    const first = await compactHistory(historyAt(0), MODEL, null, OP);
    // +20 rows of growth pushes the split point well past
    // TURN_SUMMARY_REFRESH_MIN_GROWTH (10) — one miss, one re-write, then
    // stable again. That is the honest "normal price of compaction".
    const later = await compactHistory(historyAt(10), MODEL, null, OP);
    expect(mockSummarize).toHaveBeenCalledTimes(2);
    expect(JSON.stringify(later.messages[0])).not.toBe(JSON.stringify(first.messages[0]));

    // Stable again immediately after the refresh.
    const after = await compactHistory(historyAt(11), MODEL, null, OP);
    expect(mockSummarize).toHaveBeenCalledTimes(2);
    expect(JSON.stringify(after.messages[0])).toBe(JSON.stringify(later.messages[0]));
  });

  it("never reuses a summary across ops (per-op key, hash-verified head)", async () => {
    await compactHistory(historyAt(0), MODEL, null, "op-A");
    await compactHistory(historyAt(0), MODEL, null, "op-B");
    expect(mockSummarize).toHaveBeenCalledTimes(2);
  });

  it("stays stateless for callers without an opId", async () => {
    await compactHistory(historyAt(0), MODEL, null, undefined);
    await compactHistory(historyAt(1), MODEL, null, undefined);
    expect(mockSummarize).toHaveBeenCalledTimes(2);
  });
});
