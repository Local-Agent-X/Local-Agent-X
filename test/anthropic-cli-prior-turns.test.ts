/**
 * Regression tests for the Anthropic CLI proxy's prior-turn serialization.
 *
 * Background: the CLI proxy (`streamViaCliWithTools`) takes a single text
 * prompt and runs with `--no-session-persistence`, so prior conversation
 * history has to be serialized into the prompt explicitly. Earlier the
 * proxy dropped everything before the last user message ("skip to avoid
 * stale history"), which made every chat turn look like a fresh chat to
 * the model. Live failure: "open my x account" → "X is open" → "make a
 * post" → "what platform?" because turn 2 never saw turn 1.
 *
 * These tests pin the contract of `serializePriorTurns` so the bug
 * doesn't regress.
 */
import { describe, it, expect } from "vitest";
import type { ChatCompletionMessageParam } from "openai/resources/chat/completions.js";
import { serializePriorTurns } from "../src/anthropic-client/stream-cli.js";

function findLastUserIdx(messages: ChatCompletionMessageParam[]): number {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === "user") return i;
  }
  return -1;
}

describe("serializePriorTurns", () => {
  it("returns empty string when there is no prior turn", () => {
    const messages: ChatCompletionMessageParam[] = [
      { role: "user", content: "hi" },
    ];
    expect(serializePriorTurns(messages, findLastUserIdx(messages))).toBe("");
  });

  it("returns empty string when messages array is empty", () => {
    expect(serializePriorTurns([], -1)).toBe("");
  });

  it("includes prior user and assistant text — the original bug repro", () => {
    const messages: ChatCompletionMessageParam[] = [
      { role: "user", content: "open my x account" },
      { role: "assistant", content: "X is open — already logged in on your home timeline." },
      { role: "user", content: "nice can you make a post for me" },
    ];
    const out = serializePriorTurns(messages, findLastUserIdx(messages));
    expect(out).toContain("Prior conversation:");
    expect(out).toContain("User: open my x account");
    expect(out).toContain("Assistant: X is open — already logged in on your home timeline.");
    // Current user message must NOT be in the prior block (it's appended
    // separately as the actual prompt by the caller).
    expect(out).not.toContain("nice can you make a post for me");
  });

  it("skips tool rows entirely (they orphan without their tool_use pair)", () => {
    const messages: ChatCompletionMessageParam[] = [
      { role: "user", content: "open my x account" },
      { role: "assistant", content: null, tool_calls: [{
        id: "tc_1",
        type: "function",
        function: { name: "browser_navigate", arguments: '{"url":"https://x.com"}' },
      }] } as ChatCompletionMessageParam,
      { role: "tool", tool_call_id: "tc_1", content: "navigated to x.com" } as ChatCompletionMessageParam,
      { role: "assistant", content: "X is open" },
      { role: "user", content: "make a post" },
    ];
    const out = serializePriorTurns(messages, findLastUserIdx(messages));
    expect(out).toContain("User: open my x account");
    expect(out).toContain("Assistant: X is open");
    // Tool row content + tool_calls metadata must not leak into the prompt.
    expect(out).not.toContain("navigated to x.com");
    expect(out).not.toContain("browser_navigate");
    expect(out).not.toContain("[called");
    // Assistant message that ONLY has tool_calls (no text) is skipped.
    const assistantOccurrences = (out.match(/^Assistant:/gm) || []).length;
    expect(assistantOccurrences).toBe(1);
  });

  it("skips system rows (they're baked into fullSystem upstream)", () => {
    const messages: ChatCompletionMessageParam[] = [
      { role: "system", content: "[COMPACTED CONTEXT]" } as ChatCompletionMessageParam,
      { role: "user", content: "what was that?" },
      { role: "assistant", content: "the kanban thing" },
      { role: "user", content: "right" },
    ];
    const out = serializePriorTurns(messages, findLastUserIdx(messages));
    expect(out).not.toContain("[COMPACTED CONTEXT]");
    expect(out).toContain("User: what was that?");
    expect(out).toContain("Assistant: the kanban thing");
  });

  it("caps per-message text length", () => {
    const longText = "x".repeat(5000);
    const messages: ChatCompletionMessageParam[] = [
      { role: "user", content: longText },
      { role: "assistant", content: longText },
      { role: "user", content: "ok" },
    ];
    const out = serializePriorTurns(messages, findLastUserIdx(messages));
    // Per-message cap is 1500; with the "User: " / "Assistant: " prefix
    // each line is ≤ ~1512 chars. Total prior block must not include the
    // full 5000-char repeats.
    expect(out.length).toBeLessThan(5000);
    expect(out).toContain("User: " + "x".repeat(1500));
    expect(out).not.toContain("x".repeat(1501));
  });

  it("caps to last 20 messages even if the array has more", () => {
    const messages: ChatCompletionMessageParam[] = [];
    for (let i = 0; i < 30; i++) {
      messages.push({ role: "user", content: `msg ${i}` });
      messages.push({ role: "assistant", content: `reply ${i}` });
    }
    messages.push({ role: "user", content: "current" });
    const out = serializePriorTurns(messages, findLastUserIdx(messages));
    // Last 20 of the prior 60 messages → indices 40..59 → msg 20..29 + reply 20..29
    expect(out).toContain("User: msg 20");
    expect(out).toContain("Assistant: reply 29");
    // Earlier messages must be dropped.
    expect(out).not.toContain("msg 19");
    expect(out).not.toContain("reply 0");
  });

  it("extracts text from multi-part user content (image + text)", () => {
    const messages: ChatCompletionMessageParam[] = [
      {
        role: "user",
        content: [
          { type: "text", text: "look at this" },
          { type: "image_url", image_url: { url: "data:image/png;base64,abc" } },
        ],
      } as ChatCompletionMessageParam,
      { role: "assistant", content: "I see a diagram" },
      { role: "user", content: "what's it for?" },
    ];
    const out = serializePriorTurns(messages, findLastUserIdx(messages));
    expect(out).toContain("User: look at this");
    expect(out).toContain("Assistant: I see a diagram");
    // Base64 payload must not bleed into the serialized history.
    expect(out).not.toContain("base64");
    expect(out).not.toContain("abc");
  });

  it("skips empty/whitespace-only messages", () => {
    const messages: ChatCompletionMessageParam[] = [
      { role: "user", content: "" },
      { role: "assistant", content: "   " },
      { role: "user", content: "real question" },
      { role: "assistant", content: "real answer" },
      { role: "user", content: "follow up" },
    ];
    const out = serializePriorTurns(messages, findLastUserIdx(messages));
    expect(out).toContain("User: real question");
    expect(out).toContain("Assistant: real answer");
    // The empty leading turns should produce no User:/Assistant: lines for them.
    const userLines = (out.match(/^User:/gm) || []).length;
    const assistantLines = (out.match(/^Assistant:/gm) || []).length;
    expect(userLines).toBe(1);
    expect(assistantLines).toBe(1);
  });
});
