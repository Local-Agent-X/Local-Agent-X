import { describe, it, expect, vi, beforeEach } from "vitest";
import type { ChatCompletionMessageParam } from "openai/resources/chat/completions.js";

const summarize = vi.hoisted(() => vi.fn<(m: unknown[]) => Promise<string | null>>());
vi.mock("./compaction.js", () => ({ summarizeOldMessages: summarize }));

const { applyCheckpoint, checkpointedHistory } = await import("./checkpoint-history.js");

const msg = (i: number): ChatCompletionMessageParam =>
  ({ role: i % 2 === 0 ? "user" : "assistant", content: `message ${i} ${"x".repeat(400)}` } as ChatCompletionMessageParam);

const conversation = (n: number) => Array.from({ length: n }, (_, i) => msg(i));

beforeEach(() => {
  summarize.mockReset();
  summarize.mockResolvedValue("earlier: they set up the CRM and fixed the invoice bug");
});

describe("applying an existing checkpoint", () => {
  it("replaces the covered messages with one summary row and keeps the tail verbatim", () => {
    const out = applyCheckpoint(conversation(10), { summary: "the gist", coversThrough: 6 });
    expect(out).toHaveLength(5); // summary + 4 tail
    expect(out[0].role).toBe("system");
    expect(String(out[0].content)).toContain("the gist");
    expect(String(out[1].content)).toContain("message 6");
  });

  it("ignores a checkpoint that reaches past the end", () => {
    const messages = conversation(4);
    expect(applyCheckpoint(messages, { summary: "x", coversThrough: 99 })).toBe(messages);
  });

  it("no checkpoint → the conversation, untouched", () => {
    const messages = conversation(4);
    expect(applyCheckpoint(messages, undefined)).toBe(messages);
  });
});

describe("deciding when to checkpoint", () => {
  it("leaves a short conversation alone and calls no summarizer", async () => {
    const out = await checkpointedHistory(conversation(6), {}, 200_000);
    expect(out.newCheckpoint).toBeUndefined();
    expect(out.messages).toHaveLength(6);
    expect(summarize).not.toHaveBeenCalled();
  });

  it("checkpoints once the conversation outgrows its share of the window", async () => {
    const out = await checkpointedHistory(conversation(60), {}, 8_000);
    expect(out.newCheckpoint, "a conversation over budget should have been checkpointed").toBeDefined();
    expect(out.newCheckpoint!.coversThrough).toBe(52); // keeps the last 8 verbatim
    expect(out.messages[0].role).toBe("system");
    expect(out.messages).toHaveLength(9);
  });

  // The whole point: the old part must be the SAME bytes next message, or the
  // provider's cache prefix breaks on a conversation that didn't change.
  it("reuses an existing checkpoint verbatim instead of re-summarizing", async () => {
    const existing = { summary: "the gist so far", coversThrough: 52 };
    const first = await checkpointedHistory(conversation(60), { compactionCheckpoint: existing }, 8_000);
    const second = await checkpointedHistory(conversation(62), { compactionCheckpoint: existing }, 8_000);
    expect(summarize).not.toHaveBeenCalled();
    expect(first.newCheckpoint).toBeUndefined();
    expect(second.newCheckpoint).toBeUndefined();
    // Byte-identical head, two messages apart.
    expect(second.messages[0]).toEqual(first.messages[0]);
    expect(String(second.messages[1].content)).toBe(String(first.messages[1].content));
  });

  it("re-cuts only once the tail has grown enough to be worth it", async () => {
    // Both cases are OVER budget — the only difference is how much the tail
    // has grown since the last cut.
    const existing = { summary: "the gist so far", coversThrough: 40 };
    const notYet = await checkpointedHistory(conversation(50), { compactionCheckpoint: existing }, 2_000);
    expect(notYet.newCheckpoint, "10 new messages is under the re-cut threshold").toBeUndefined();

    const now = await checkpointedHistory(conversation(80), { compactionCheckpoint: existing }, 2_000);
    expect(now.newCheckpoint).toBeDefined();
    expect(now.newCheckpoint!.coversThrough).toBeGreaterThan(existing.coversThrough);
  });

  it("a failed summarize sends the conversation rather than dropping it", async () => {
    summarize.mockResolvedValue(null);
    const out = await checkpointedHistory(conversation(60), {}, 8_000);
    expect(out.newCheckpoint).toBeUndefined();
    expect(out.messages).toHaveLength(60);
  });
});
