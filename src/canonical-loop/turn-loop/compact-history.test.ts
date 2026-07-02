import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../../context-manager/status.js", () => ({ getContextStatus: vi.fn() }));
vi.mock("../../context-manager/compaction.js", () => ({ summarizeOldMessages: vi.fn() }));

import { compactHistory, safeSplitIndex, toChatParams } from "./compact-history.js";
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

const status = (percentage: number, shouldCompact: boolean) =>
  ({ usedTokens: 1, maxTokens: 1, percentage, level: "compact" as const, shouldCompact, forceCompact: false });

beforeEach(() => { mockStatus.mockReset(); mockSummarize.mockReset(); });

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
    expect(out).toBe(msgs);
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
    expect(out).toBe(msgs);
  });

  it("replaces the head with a summary and never orphans a tool_result", async () => {
    mockStatus.mockReturnValue(status(96, true)); // keepLast = 4
    mockSummarize.mockResolvedValue("DECISIONS: ship it");
    const msgs = [
      u("u1", "first ask"), a("a1", "", [{ id: "t1", name: "read", arguments: "{}" }]), tr("r1", "t1", "res1"),
      u("u2", "second ask"), a("a2", "", [{ id: "t2", name: "read", arguments: "{}" }]), tr("r2", "t2", "res2"),
      u("u3", "latest ask"), a("a3", "working"),
    ];
    const out = await compactHistory(msgs, "claude-sonnet-4-6");

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
    const out = await compactHistory(msgs, "claude-sonnet-4-6");

    // boundary is user u3 (index 4): summary folds into it, no synthetic row added.
    expect(out[0].role).toBe("user");
    expect(out[0].messageId).toBe("u3");
    const text = (out[0].content as { text: string }).text;
    expect(text).toContain("DECISIONS: ship it");
    expect(text).toContain("third ask");
    expect(out.find(m => m.messageId === "u1")).toBeUndefined();
  });
});
