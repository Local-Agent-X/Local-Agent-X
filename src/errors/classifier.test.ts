/**
 * Regression: real provider overflow messages must classify as
 * ContextOverflow → "compress". Both major providers ship overflow as HTTP
 * 400, and the old pattern (payload too large / max token / content too long)
 * matched NEITHER of their actual message shapes — so an overflow classified
 * as FormatError → "abort" and the op died instead of compacting + retrying.
 * FAILS on old code for the first two cases.
 */
import { describe, it, expect } from "vitest";
import { classify, FailoverReason } from "./classifier.js";

describe("classify — provider context-overflow messages", () => {
  it("Anthropic 'prompt is too long' (ships as HTTP 400)", () => {
    const err = Object.assign(new Error("prompt is too long: 214315 tokens > 200000 maximum"), { status: 400 });
    const c = classify(err);
    expect(c.reason).toBe(FailoverReason.ContextOverflow);
    expect(c.recovery).toBe("compress");
  });

  it("OpenAI 'maximum context length' (ships as HTTP 400)", () => {
    const err = Object.assign(
      new Error("This model's maximum context length is 128000 tokens. However, your messages resulted in 131201 tokens."),
      { status: 400 },
    );
    const c = classify(err);
    expect(c.reason).toBe(FailoverReason.ContextOverflow);
    expect(c.recovery).toBe("compress");
  });

  it("HTTP 413 payload too large", () => {
    const c = classify(Object.assign(new Error("Request Entity Too Large"), { status: 413 }));
    expect(c.reason).toBe(FailoverReason.ContextOverflow);
    expect(c.recovery).toBe("compress");
  });

  it("a plain 400 without overflow language still classifies as FormatError", () => {
    const c = classify(Object.assign(new Error("bad request: invalid tool schema"), { status: 400 }));
    expect(c.reason).toBe(FailoverReason.FormatError);
    expect(c.recovery).toBe("abort");
  });
});
