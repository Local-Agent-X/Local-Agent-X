import { describe, it, expect } from "vitest";
import type { ChatCompletionMessageParam } from "openai/resources/chat/completions.js";

import { anchoredTotalTokens, messageTokens, totalTokens } from "./token-estimation.js";
import { getContextStatus } from "./status.js";

const u = (text: string): ChatCompletionMessageParam => ({ role: "user", content: text });
const a = (text: string): ChatCompletionMessageParam => ({ role: "assistant", content: text });

describe("anchoredTotalTokens", () => {
  it("adds the anchor to the estimate of only the appended tail", () => {
    const msgs = [u("x".repeat(700)), a("y".repeat(700)), u("appended one"), a("appended two")];
    const tail = messageTokens(msgs[2]) + messageTokens(msgs[3]);
    expect(anchoredTotalTokens(msgs, { anchorTokens: 50_000, estimateFrom: 2 })).toBe(50_000 + tail);
  });

  it("returns exactly the anchor when nothing was appended since", () => {
    const msgs = [u("q"), a("r")];
    expect(anchoredTotalTokens(msgs, { anchorTokens: 12_345, estimateFrom: msgs.length })).toBe(12_345);
  });

  it("degenerates to the pure estimate with a zero anchor covering nothing", () => {
    const msgs = [u("hello there"), a("hi"), u("more text here")];
    expect(anchoredTotalTokens(msgs, { anchorTokens: 0, estimateFrom: 0 })).toBe(totalTokens(msgs));
  });
});

describe("getContextStatus with/without anchor", () => {
  // claude-sonnet-4-6: 200k window, anthropic-class thresholds (60/75/90).
  const model = "claude-sonnet-4-6";

  it("without an anchor sizes by pure estimate (historical behavior)", () => {
    const msgs = [u("short question"), a("short answer")];
    const status = getContextStatus(msgs, model);
    expect(status.usedTokens).toBe(totalTokens(msgs));
    expect(status.level).toBe("ok");
    expect(status.shouldCompact).toBe(false);
  });

  it("with an anchor sizes from real usage plus the appended estimate", () => {
    const msgs = [u("seed"), a("reply"), u("appended after the response")];
    const anchor = { anchorTokens: 160_000, estimateFrom: 2 };
    const status = getContextStatus(msgs, model, anchor);
    expect(status.usedTokens).toBe(anchoredTotalTokens(msgs, anchor));
    // 160k of 200k = 80% → compact band; the pure estimate would have been "ok".
    expect(status.shouldCompact).toBe(true);
    expect(status.level).toBe("compact");
    expect(getContextStatus(msgs, model).shouldCompact).toBe(false);
  });

  it("an anchor over the critical threshold forces compaction", () => {
    const msgs = [u("seed"), a("reply")];
    const status = getContextStatus(msgs, model, { anchorTokens: 190_000, estimateFrom: msgs.length });
    expect(status.level).toBe("critical");
    expect(status.forceCompact).toBe(true);
  });
});
