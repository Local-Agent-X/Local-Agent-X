import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../../context-manager/status.js", () => ({ getContextStatus: vi.fn() }));
vi.mock("../../context-manager/compaction.js", () => ({ summarizeOldMessages: vi.fn() }));

import { compactHistory, safeSplitIndex } from "./compact-history.js";
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

  it("never splits an assistant tool_use from its tool_result — lands on a user row", () => {
    const msgs = [
      u("u1", "q1"), a("a1", "", [{ id: "t1", name: "read", arguments: "{}" }]), tr("r1", "t1", "res1"),
      u("u2", "q2"), a("a2", "", [{ id: "t2", name: "read", arguments: "{}" }]), tr("r2", "t2", "res2"),
      u("u3", "q3"), a("a3", "done"),
    ];
    // naive boundary (len-3 = idx 5) lands on tr "r2" — unsafe; must walk back to u2.
    const idx = safeSplitIndex(msgs, 3);
    expect(msgs[idx].role).toBe("user");
    expect(msgs[idx].messageId).toBe("u2");
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

  it("replaces head with a summary on the boundary user message and never orphans a tool_result", async () => {
    mockStatus.mockReturnValue(status(96, true)); // keepLast = 4
    mockSummarize.mockResolvedValue("DECISIONS: ship it");
    const msgs = [
      u("u1", "first ask"), a("a1", "", [{ id: "t1", name: "read", arguments: "{}" }]), tr("r1", "t1", "res1"),
      u("u2", "second ask"), a("a2", "", [{ id: "t2", name: "read", arguments: "{}" }]), tr("r2", "t2", "res2"),
      u("u3", "latest ask"), a("a3", "working"),
    ];
    const out = await compactHistory(msgs, "claude-sonnet-4-6");

    // boundary user row now carries the summary AND its original text
    expect(out[0].role).toBe("user");
    const text = (out[0].content as { text: string }).text;
    expect(text).toContain("DECISIONS: ship it");
    expect(text).toContain("auto-summarized");
    expect(text).toContain("second ask");

    // head (u1/a1/r1) is gone
    expect(out.find(m => m.messageId === "u1")).toBeUndefined();
    expect(out.find(m => m.messageId === "r1")).toBeUndefined();

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
});
