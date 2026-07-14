import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../../context-manager/status.js", () => ({ getContextStatus: vi.fn() }));
vi.mock("../../context-manager/compaction.js", () => ({ summarizeOldMessages: vi.fn() }));
// Pin the transport so the getContextStatus call signature is deterministic
// (the real resolver reads auth state / the box's saved credentials).
vi.mock("../../context-manager/resolve-transport.js", () => ({ resolveAnthropicTransport: () => "cli" }));

const loggerMock = vi.hoisted(() => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }));
vi.mock("../../logger.js", () => ({ createLogger: () => loggerMock }));

import { compactHistory, forceCompactNext, locateAnchor, safeSplitIndex, toChatParams } from "./compact-history.js";
import { parseCursor } from "../../tools/recall-tool.js";
import { getContextStatus } from "../../context-manager/status.js";
import { summarizeOldMessages } from "../../context-manager/compaction.js";
import type { CanonicalMessage } from "../contract-types.js";

const mockStatus = vi.mocked(getContextStatus);
const mockSummarize = vi.mocked(summarizeOldMessages);

const u = (id: string, text: string): CanonicalMessage => ({ messageId: id, role: "user", content: { text } });
const a = (id: string, text: string, toolCalls?: unknown[]): CanonicalMessage =>
  ({ messageId: id, role: "assistant", content: toolCalls ? { text, toolCalls } : { text } });
const tr = (id: string, toolCallId: string, result: string): CanonicalMessage =>
  ({ messageId: id, role: "tool_result", content: { toolCallId, result } });

// Stamp a row with the (turnIdx, seqInTurn) it was finalized at.
const at = (m: CanonicalMessage, turnIdx: number, seqInTurn = 0): CanonicalMessage =>
  ({ ...m, turnIdx, seqInTurn });

const status = (percentage: number, shouldCompact: boolean) =>
  ({ usedTokens: 1, maxTokens: 1, percentage, level: "compact" as const, shouldCompact, forceCompact: false });

beforeEach(() => {
  mockStatus.mockReset();
  mockSummarize.mockReset();
  loggerMock.debug.mockReset();
  loggerMock.error.mockReset();
});

describe("safeSplitIndex — tool-pairing-safe boundary", () => {
  it("returns 0 when there's too little to compact", () => {
    expect(safeSplitIndex([u("1", "a"), a("2", "b")], 6)).toBe(0);
  });

  it("never splits an assistant tool_use from its tool_result — backs off onto the turn-start", () => {
    const msgs = [
      u("u1", "q1"), a("a1", "", [{ id: "t1", name: "read", arguments: "{}" }]), tr("r1", "t1", "res1"),
      u("u2", "q2"), a("a2", "", [{ id: "t2", name: "read", arguments: "{}" }]), tr("r2", "t2", "res2"),
      u("u3", "q3"), a("a3", "done"),
    ];
    // naive boundary (len-3 = idx 5) lands on tr "r2" — unsafe; back off onto the
    // nearest turn-start a2 (index 4), which keeps a2↔r2 paired in the tail.
    const idx = safeSplitIndex(msgs, 3);
    expect(msgs[idx].role).not.toBe("tool_result");
    expect(msgs[idx].messageId).toBe("a2");
  });

  // Defect B: a long background/agent op has ONE seed user row then hundreds of
  // assistant/tool_result rows. The old walk-to-`user` rule hit index 0 and
  // returned 0 → compaction was a structural no-op on exactly the ops it exists
  // for. FAILS on old code (returns 0).
  it("compacts a single-user op — splits on a turn-start, never on a tool_result", () => {
    const msgs = [
      u("u1", "go"),
      a("a1", "", [{ id: "t1", name: "read", arguments: "{}" }]), tr("r1", "t1", "res1"),
      a("a2", "", [{ id: "t2", name: "read", arguments: "{}" }]), tr("r2", "t2", "res2"),
      a("a3", "done"),
    ];
    const idx = safeSplitIndex(msgs, 2);
    expect(idx).toBeGreaterThan(0);
    expect(msgs[idx].role).not.toBe("tool_result");
  });
});

describe("toChatParams — tool payloads reach the token estimator (Defect A)", () => {
  // FAILS on old code: tool_result read only `content.text` → projected as
  // "[tool result] " (blank), so a 4000-char result counted as ~4 tokens.
  it("surfaces a tool_result payload stored under content.result", () => {
    const big = "x".repeat(4000);
    const [row] = toChatParams([tr("r1", "t1", big)]);
    expect(typeof row.content).toBe("string");
    expect((row.content as string).length).toBeGreaterThan(4000);
    expect(row.content as string).toContain(big);
  });

  // FAILS on old code: a tool-only assistant turn ({text:"", toolCalls}) read
  // only `.text` → projected empty, so the estimator/summarizer never saw the call.
  it("surfaces assistant tool_calls as a non-empty marker", () => {
    const [row] = toChatParams([a("a1", "", [{ id: "t1", name: "web_search", arguments: '{"q":"x"}' }])]);
    expect(row.content as string).toContain("web_search");
    expect((row.content as string).length).toBeGreaterThan(0);
  });
});

describe("compactHistory", () => {
  it("is a no-op when under threshold and never calls the summarizer", async () => {
    mockStatus.mockReturnValue(status(10, false));
    const msgs = [u("1", "hi"), a("2", "yo"), u("3", "more")];
    const out = await compactHistory(msgs, "claude-opus-4-8");
    expect(out.messages).toBe(msgs);
    expect(out.compacted).toBe(false);
    expect(mockSummarize).not.toHaveBeenCalled();
  });

  it("keeps full history when summarization is unavailable — no silent truncation", async () => {
    mockStatus.mockReturnValue(status(96, true));
    mockSummarize.mockResolvedValue(null);
    const msgs = [
      u("u1", "q1"), a("a1", "r1"), u("u2", "q2"), a("a2", "r2"),
      u("u3", "q3"), a("a3", "r3"), u("u4", "q4"), a("a4", "r4"),
    ];
    const out = await compactHistory(msgs, "claude-sonnet-4-6");
    expect(mockSummarize).toHaveBeenCalled();
    expect(out.messages).toBe(msgs);
    expect(out.compacted).toBe(false);
  });

  it("replaces the head with a summary and never orphans a tool_result", async () => {
    mockStatus.mockReturnValue(status(96, true)); // keepLast = 4
    mockSummarize.mockResolvedValue("DECISIONS: ship it");
    const msgs = [
      u("u1", "first ask"), a("a1", "", [{ id: "t1", name: "read", arguments: "{}" }]), tr("r1", "t1", "res1"),
      u("u2", "second ask"), a("a2", "", [{ id: "t2", name: "read", arguments: "{}" }]), tr("r2", "t2", "res2"),
      u("u3", "latest ask"), a("a3", "working"),
    ];
    const { messages: out, compacted } = await compactHistory(msgs, "claude-sonnet-4-6");
    expect(compacted).toBe(true);

    // boundary is assistant a2 (index 4), so the summary lands on a fresh leading
    // user row (keeps the provider "first message is user" invariant); the
    // assistant turn-start it precedes survives untouched, tool_calls intact.
    expect(out[0].role).toBe("user");
    const text = (out[0].content as { text: string }).text;
    expect(text).toContain("DECISIONS: ship it");
    expect(text).toContain("auto-summarized");
    expect(out[1].messageId).toBe("a2");
    expect((out[1].content as { toolCalls?: unknown[] }).toolCalls).toHaveLength(1);

    // head (u1/a1/r1/u2) is gone
    expect(out.find(m => m.messageId === "u1")).toBeUndefined();
    expect(out.find(m => m.messageId === "r1")).toBeUndefined();
    expect(out.find(m => m.messageId === "u2")).toBeUndefined();

    // every surviving tool_result has its assistant tool_use earlier in the output
    const seen = new Set<string>();
    for (const m of out) {
      if (m.role === "assistant") {
        const tc = (m.content as { toolCalls?: Array<{ id: string }> }).toolCalls;
        if (Array.isArray(tc)) for (const c of tc) seen.add(c.id);
      }
      if (m.role === "tool_result") {
        const id = (m.content as { toolCallId?: string }).toolCallId!;
        expect(seen.has(id), `orphaned tool_result ${m.messageId} (call ${id})`).toBe(true);
      }
    }
  });

  // A boundary that lands directly on a user row folds the summary INTO that row
  // (no extra message → no adjacent-user rejection). keepLast=4 over a history
  // whose tail starts on a user row exercises this branch.
  it("folds the summary into the boundary when the tail starts on a user row", async () => {
    mockStatus.mockReturnValue(status(96, true)); // keepLast = 4
    mockSummarize.mockResolvedValue("DECISIONS: ship it");
    const msgs = [
      u("u1", "first"), a("a1", "r1"), u("u2", "second"), a("a2", "r2"),
      u("u3", "third ask"), a("a3", "r3"), u("u4", "fourth ask"), a("a4", "r4"),
    ];
    const { messages: out, compacted } = await compactHistory(msgs, "claude-sonnet-4-6");
    expect(compacted).toBe(true);

    // boundary is user u3 (index 4): summary folds into it, no synthetic row added.
    expect(out[0].role).toBe("user");
    expect(out[0].messageId).toBe("u3");
    const text = (out[0].content as { text: string }).text;
    expect(text).toContain("DECISIONS: ship it");
    expect(text).toContain("third ask");
    expect(out.find(m => m.messageId === "u1")).toBeUndefined();
  });
});

describe("locateAnchor — mapping real usage onto the message view", () => {
  it("anchors after the assistant response; later rows are the estimated tail", () => {
    const msgs = [
      at(u("u1", "seed"), 0, 0),
      at(a("a0", "r0"), 0, 1),
      at(u("u2", "next"), 1, 0),
      at(a("a1", "r1"), 1, 1),          // ← anchoring response
      at(tr("r1", "t1", "res"), 1, 2),  // appended after it
      at(u("n1", "nudge"), 2, 0),
    ];
    const anchor = locateAnchor(msgs, { turnIdx: 1, contextTokens: 42_000 });
    expect(anchor).toEqual({ anchorTokens: 42_000, estimateFrom: 4 });
  });

  it("tool-only anchor turn (no assistant row): its tool_results are the appended tail", () => {
    const msgs = [
      at(u("u1", "go"), 0, 0),
      at(tr("r1", "t1", "res1"), 0, 1),
      at(tr("r2", "t2", "res2"), 0, 2),
    ];
    const anchor = locateAnchor(msgs, { turnIdx: 0, contextTokens: 9_000 });
    expect(anchor).toEqual({ anchorTokens: 9_000, estimateFrom: 1 });
  });

  it("anchor covers everything when nothing was appended since the response", () => {
    const msgs = [at(u("u1", "q"), 0, 0), at(a("a1", "r"), 0, 1)];
    const anchor = locateAnchor(msgs, { turnIdx: 0, contextTokens: 5_000 });
    expect(anchor).toEqual({ anchorTokens: 5_000, estimateFrom: 2 });
  });

  it("refuses to map when a row is missing turnIdx", () => {
    const msgs = [at(u("u1", "q"), 0, 0), a("a1", "r")]; // a1 has no turnIdx
    expect(locateAnchor(msgs, { turnIdx: 0, contextTokens: 5_000 })).toBeNull();
  });

  it("refuses to map when a compaction summary row reshaped the view", () => {
    const msgs = [
      at({ messageId: "compact-summary-a1", role: "user", content: { text: "[summary]" } }, 0, 0),
      at(a("a1", "r"), 0, 1),
    ];
    expect(locateAnchor(msgs, { turnIdx: 0, contextTokens: 5_000 })).toBeNull();
  });

  it("refuses to map when rows don't split cleanly around the anchor turn", () => {
    const msgs = [
      at(u("u2", "later"), 2, 0), // later-turn row BEFORE the anchor turn's rows
      at(a("a1", "r1"), 1, 1),
      at(tr("r1", "t1", "res"), 1, 2),
    ];
    expect(locateAnchor(msgs, { turnIdx: 1, contextTokens: 5_000 })).toBeNull();
  });
});

describe("compactHistory — anchored sizing", () => {
  it("sizes via the mapped anchor when last-turn usage is provided", async () => {
    mockStatus.mockReturnValue(status(10, false));
    const msgs = [
      at(u("u1", "seed"), 0, 0),
      at(a("a1", "r1"), 0, 1),
      at(tr("r1", "t1", "res"), 0, 2),
    ];
    await compactHistory(msgs, "claude-opus-4-8", { turnIdx: 0, contextTokens: 77_000 });
    expect(mockStatus).toHaveBeenCalledWith(
      expect.any(Array),
      "claude-opus-4-8",
      { anchorTokens: 77_000, estimateFrom: 2 },
      "cli",
      0,
    );
  });

  it("falls back to the pure estimate when the anchor can't map onto the view", async () => {
    mockStatus.mockReturnValue(status(10, false));
    const msgs = [u("u1", "seed"), a("a1", "r1")]; // no turnIdx on rows
    await compactHistory(msgs, "claude-opus-4-8", { turnIdx: 0, contextTokens: 77_000 });
    expect(mockStatus).toHaveBeenCalledWith(expect.any(Array), "claude-opus-4-8", undefined, "cli", 0);
  });

  it("passes no anchor when no usage was recorded", async () => {
    mockStatus.mockReturnValue(status(10, false));
    const msgs = [at(u("u1", "seed"), 0, 0), at(a("a1", "r1"), 0, 1)];
    await compactHistory(msgs, "claude-opus-4-8");
    expect(mockStatus).toHaveBeenCalledWith(expect.any(Array), "claude-opus-4-8", undefined, "cli", 0);
  });

  // Baseline floor is threaded to getContextStatus as the 5th arg so the pure-
  // estimate branch can account for the system prompt + tool manifest.
  it("threads the baseline token floor to getContextStatus", async () => {
    mockStatus.mockReturnValue(status(10, false));
    const msgs = [at(u("u1", "seed"), 0, 0), at(a("a1", "r1"), 0, 1)];
    await compactHistory(msgs, "claude-opus-4-8", null, "op1", 147_000);
    expect(mockStatus).toHaveBeenCalledWith(expect.any(Array), "claude-opus-4-8", undefined, "cli", 147_000);
  });
});

// Regression: overflow recovery. When the PROVIDER rejects a call as
// over-window, the threshold estimate demonstrably undershot — the retry must
// compact even though getContextStatus still says "under threshold". FAILS on
// old code (no forceCompactNext; the under-threshold early-return wins and the
// retry re-sends the exact same oversized view).
describe("compactHistory — forced compaction (provider overflow recovery)", () => {
  it("compacts under threshold when forced, with the aggressive keep", async () => {
    mockStatus.mockReturnValue(status(60, false)); // estimate says fine — provider said otherwise
    mockSummarize.mockResolvedValue("DECISIONS: keep going");
    const msgs = [
      u("u1", "q1"), a("a1", "r1"), u("u2", "q2"), a("a2", "r2"),
      u("u3", "q3"), a("a3", "r3"), u("u4", "q4"), a("a4", "r4"),
    ];
    forceCompactNext("op-ovf");
    const out = await compactHistory(msgs, "claude-opus-4-8", null, "op-ovf");
    expect(out.compacted).toBe(true);
    expect(mockSummarize).toHaveBeenCalled();
    // keepLast=2 (aggressive): only the last two rows survive verbatim.
    expect(out.messages.find(m => m.messageId === "u3")).toBeUndefined();
    expect(out.messages.find(m => m.messageId === "a4")).toBeDefined();
  });

  it("consumes the marker once — the next call is threshold-gated again", async () => {
    mockStatus.mockReturnValue(status(60, false));
    mockSummarize.mockResolvedValue("DECISIONS: keep going");
    const msgs = [
      u("u1", "q1"), a("a1", "r1"), u("u2", "q2"), a("a2", "r2"),
      u("u3", "q3"), a("a3", "r3"), u("u4", "q4"), a("a4", "r4"),
    ];
    forceCompactNext("op-once");
    expect((await compactHistory(msgs, "claude-opus-4-8", null, "op-once")).compacted).toBe(true);
    mockSummarize.mockClear();
    const second = await compactHistory(msgs, "claude-opus-4-8", null, "op-once");
    expect(second.compacted).toBe(false);
    expect(mockSummarize).not.toHaveBeenCalled();
  });
});

// The summary must cite the replaced span so the model (and the user) can page
// the original rows back via the recall tool's "startId:endId" range cursor.
describe("compactHistory — replaced-range citation for recall", () => {
  const recallCursorOf = (text: string): string => {
    const m = text.match(/recall tool with cursor="([^"]+)"/);
    expect(m, "recall hint line missing").not.toBeNull();
    return m![1];
  };

  it("standalone summary row cites the head's first:last ids and a recall hint", async () => {
    mockStatus.mockReturnValue(status(96, true)); // keepLast = 4
    mockSummarize.mockResolvedValue("DECISIONS: ship it");
    const msgs = [
      u("u1", "first ask"), a("a1", "", [{ id: "t1", name: "read", arguments: "{}" }]), tr("r1", "t1", "res1"),
      u("u2", "second ask"), a("a2", "", [{ id: "t2", name: "read", arguments: "{}" }]), tr("r2", "t2", "res2"),
      u("u3", "latest ask"), a("a3", "working"),
    ];
    const { messages: out } = await compactHistory(msgs, "claude-sonnet-4-6");
    // head = u1..u2 (split lands on a2) → range u1:u2
    const content = out[0].content as { text: string; summaryRange?: { firstId: string; lastId: string } };
    expect(content.text).toContain("messages, range u1:u2]");
    expect(recallCursorOf(content.text)).toBe("u1:u2");
    expect(content.summaryRange).toEqual({ firstId: "u1", lastId: "u2" });
    // the compacted view stays deliberately un-anchorable
    expect(locateAnchor(out, { turnIdx: 0, contextTokens: 1_000 })).toBeNull();
  });

  it("merged-into-user-row branch carries the same range text and metadata", async () => {
    mockStatus.mockReturnValue(status(96, true)); // keepLast = 4
    mockSummarize.mockResolvedValue("DECISIONS: ship it");
    const msgs = [
      u("u1", "first"), a("a1", "r1"), u("u2", "second"), a("a2", "r2"),
      u("u3", "third ask"), a("a3", "r3"), u("u4", "fourth ask"), a("a4", "r4"),
    ];
    const { messages: out } = await compactHistory(msgs, "claude-sonnet-4-6");
    expect(out[0].messageId).toBe("u3"); // merged branch, not a synthetic row
    const content = out[0].content as { text: string; summaryRange?: { firstId: string; lastId: string } };
    expect(content.text).toContain("messages, range u1:a2]");
    expect(recallCursorOf(content.text)).toBe("u1:a2");
    expect(content.summaryRange).toEqual({ firstId: "u1", lastId: "a2" });
  });

  it("emitted cursor round-trips through recall-tool's parseCursor", async () => {
    mockStatus.mockReturnValue(status(96, true));
    mockSummarize.mockResolvedValue("DECISIONS: ship it");
    const mid = (n: number): string => `um-op1-${n}-abc12345`; // realistic dashed ids
    const msgs = [
      u(mid(0), "q1"), a(mid(1), "r1"), u(mid(2), "q2"), a(mid(3), "r2"),
      u(mid(4), "q3"), a(mid(5), "r3"), u(mid(6), "q4"), a(mid(7), "r4"),
    ];
    const { messages: out } = await compactHistory(msgs, "claude-sonnet-4-6");
    const cursor = recallCursorOf((out[0].content as { text: string }).text);
    expect(parseCursor(cursor)).toEqual({ startId: mid(0), endId: mid(3) });
  });
});

// The circuit-breaker suite (trip, reset, cool-down probes) lives in
// compact-history.breaker.test.ts — split out to keep both files under the
// repo's file-size limit.
