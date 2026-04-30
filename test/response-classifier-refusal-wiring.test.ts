import { describe, it, expect } from "vitest";
import {
  classifyAnthropicResponse,
  classifyOpenAIResponse,
  classifyCodexResponse,
} from "../src/response-classifier.js";

describe("classifyAnthropicResponse — soft-refusal wiring", () => {
  it("reclassifies end_turn+refusal text as content_filter", () => {
    const r = classifyAnthropicResponse({
      hasText: true,
      hasToolCalls: false,
      stopReason: "end_turn",
      responseText: "I cannot help with that request.",
      outputTokens: 12,
    });
    expect(r.type).toBe("content_filter");
    expect(r.shouldFallback).toBe(true);
    expect(r.shouldRetry).toBe(false);
    expect(r.meta?.refusalPattern).toBeTruthy();
  });

  it("leaves a normal end_turn answer as completed", () => {
    const r = classifyAnthropicResponse({
      hasText: true,
      hasToolCalls: false,
      stopReason: "end_turn",
      responseText: "Sure, here's the answer you wanted.",
      outputTokens: 10,
    });
    expect(r.type).toBe("completed");
    expect(r.shouldFallback).toBe(false);
  });

  it("does not reclassify when responseText is omitted", () => {
    const r = classifyAnthropicResponse({
      hasText: true,
      hasToolCalls: false,
      stopReason: "end_turn",
      outputTokens: 10,
    });
    expect(r.type).toBe("completed");
  });

  it("still honors explicit refusal stop_reason regardless of text", () => {
    const r = classifyAnthropicResponse({
      hasText: true,
      hasToolCalls: false,
      stopReason: "refusal",
      responseText: "Sure, here is your answer.",
    });
    expect(r.type).toBe("content_filter");
  });
});

describe("classifyOpenAIResponse — soft-refusal wiring", () => {
  it("reclassifies stop+refusal text as content_filter", () => {
    const r = classifyOpenAIResponse({
      hasText: true,
      hasToolCalls: false,
      finishReason: "stop",
      responseText: "I'm sorry, but I cannot help with that.",
      outputTokens: 14,
    });
    expect(r.type).toBe("content_filter");
    expect(r.shouldFallback).toBe(true);
  });

  it("leaves a normal stop answer as completed", () => {
    const r = classifyOpenAIResponse({
      hasText: true,
      hasToolCalls: false,
      finishReason: "stop",
      responseText: "Here is the function you asked for.",
      outputTokens: 9,
    });
    expect(r.type).toBe("completed");
  });
});

describe("classifyCodexResponse — soft-refusal wiring", () => {
  it("reclassifies hasText+refusal as content_filter", () => {
    const r = classifyCodexResponse({
      hasText: true,
      hasToolCalls: false,
      responseText: "I won't help with creating that.",
      inputTokens: 100,
      outputTokens: 12,
    });
    expect(r.type).toBe("content_filter");
    expect(r.shouldFallback).toBe(true);
  });

  it("leaves a normal hasText response as completed", () => {
    const r = classifyCodexResponse({
      hasText: true,
      hasToolCalls: false,
      responseText: "OK, here is the implementation.",
      outputTokens: 8,
    });
    expect(r.type).toBe("completed");
  });
});
