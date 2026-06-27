import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ChatCompletionMessageParam } from "openai/resources/chat/completions.js";

import {
  compactIfNeeded,
  compactIfNeededWithLLM,
} from "../src/context-manager/compaction.js";
import { getContextStatus } from "../src/context-manager/status.js";

// A real model id the window/pricing table knows (model-windows.ts).
// Non-codex (compactAt=75) so thresholds behave like the Anthropic family.
const MODEL = "claude-sonnet-4-6";

/** A short, plainly-under-budget conversation. */
function shortList(): ChatCompletionMessageParam[] {
  return [
    { role: "system", content: "You are a helpful agent." },
    { role: "user", content: "hi" },
    { role: "assistant", content: "hello, how can I help?" },
    { role: "user", content: "what is 2 + 2?" },
    { role: "assistant", content: "4" },
  ];
}

/**
 * A long conversation with sizable bodies. `sysCount` leading system messages,
 * then `turns` user/assistant pairs. Each message body is deterministic and
 * uniquely identifiable so we can assert verbatim tail preservation.
 */
function longList(turns = 30, sysCount = 2): ChatCompletionMessageParam[] {
  const filler = "x".repeat(400); // sizable but bounded; keeps tokens realistic
  const messages: ChatCompletionMessageParam[] = [];
  for (let s = 0; s < sysCount; s++) {
    messages.push({ role: "system", content: `SYSTEM-${s}: instructions ${filler}` });
  }
  for (let i = 0; i < turns; i++) {
    messages.push({ role: "user", content: `USER-${i}: question ${i} ${filler}` });
    messages.push({ role: "assistant", content: `ASSISTANT-${i}: answer ${i} ${filler}` });
  }
  return messages;
}

function contentOf(m: ChatCompletionMessageParam): string {
  return typeof m.content === "string" ? m.content : JSON.stringify(m.content);
}

describe("context compaction invariants (deterministic, no LLM)", () => {
  describe("compactIfNeeded — sync truncation path", () => {
    it("is a no-op under budget when not forced", () => {
      const input = shortList();
      const before = input.map(contentOf);
      const result = compactIfNeeded(input, MODEL, false);

      expect(result.compacted).toBe(false);
      // Same array reference returned untouched.
      expect(result.messages).toBe(input);
      // Contents unchanged.
      expect(result.messages.map(contentOf)).toEqual(before);
      // The fixture really is under the compaction threshold.
      expect(result.status.shouldCompact).toBe(false);
    });

    it("forced compaction shrinks the list and preserves the recent verbatim tail", () => {
      const input = longList(30, 2);
      const original = getContextStatus(input, MODEL);
      const result = compactIfNeeded(input, MODEL, true);

      expect(result.compacted).toBe(true);
      expect(result.messages.length).toBeLessThan(input.length);

      // keepLast is 6 for a comfortably-under-budget (forced) list.
      const keepLast = 6;
      const tailIn = input.slice(-keepLast).map(contentOf);
      const tailOut = result.messages.slice(-keepLast).map(contentOf);
      expect(tailOut).toEqual(tailIn);

      // Budget must not increase after compaction.
      expect(result.status.percentage).toBeLessThanOrEqual(original.percentage);
    });

    it("preserves system messages through sync compaction", () => {
      // buildCompactionPrompt returns [...systemMsgs, summaryMsg, ...recent],
      // so the original system messages survive at the front.
      const input = longList(30, 2);
      const sysContents = input
        .filter((m) => m.role === "system")
        .map(contentOf);

      const result = compactIfNeeded(input, MODEL, true);
      const outSysContents = result.messages
        .filter((m) => m.role === "system")
        .map(contentOf);

      // Every original system message is still present...
      for (const c of sysContents) {
        expect(outSysContents).toContain(c);
      }
      // ...and they lead the kept list (original system messages first).
      expect(result.messages[0].role).toBe("system");
      expect(contentOf(result.messages[0])).toBe(sysContents[0]);
    });

    it("budget percentage drops (or holds) after compaction", () => {
      const input = longList(40, 1);
      const original = getContextStatus(input, MODEL);
      const result = compactIfNeeded(input, MODEL, true);

      expect(result.compacted).toBe(true);
      expect(result.status.percentage).toBeLessThanOrEqual(original.percentage);
    });
  });

  describe("compactIfNeededWithLLM — deterministic fallback (LAX_LLM_COMPACTION=0)", () => {
    const prev = process.env.LAX_LLM_COMPACTION;

    beforeEach(() => {
      // Disable the LLM summarization call → summarizeOldMessages returns null
      // → falls back to deterministic truncation. No provider/network needed.
      process.env.LAX_LLM_COMPACTION = "0";
    });

    afterEach(() => {
      if (prev === undefined) delete process.env.LAX_LLM_COMPACTION;
      else process.env.LAX_LLM_COMPACTION = prev;
    });

    it("falls back to truncation with no API call (summarizedByLLM:false, compacted:true)", async () => {
      const input = longList(30, 2);
      const result = await compactIfNeededWithLLM(input, MODEL, true);

      expect(result.summarizedByLLM).toBe(false);
      expect(result.compacted).toBe(true);
      expect(result.messages.length).toBeLessThan(input.length);

      // The fallback routes through buildCompactionPrompt, so system messages
      // and the recent verbatim tail are preserved here too.
      const keepLast = 6;
      const tailIn = input.slice(-keepLast).map(contentOf);
      const tailOut = result.messages.slice(-keepLast).map(contentOf);
      expect(tailOut).toEqual(tailIn);
      expect(result.messages[0].role).toBe("system");
    });

    it("is a no-op under budget when not forced (no LLM call attempted)", async () => {
      const input = shortList();
      const result = await compactIfNeededWithLLM(input, MODEL, false);

      expect(result.compacted).toBe(false);
      expect(result.summarizedByLLM).toBe(false);
      expect(result.messages).toBe(input);
    });
  });
});
