import { describe, it, expect } from "vitest";
import {
  detectRefusalText,
  classifyCodexResponse,
  classifyOpenAIResponse,
} from "../src/response-classifier.js";

// HE-9: (1) a legitimate answer whose LEADING clause DESCRIBES a policy must
// not be classified as a refusal (which would reclassify a completed turn as
// content_filter and replay it); (2) a zero-token empty stream on a
// non-moderating / local provider must be a retryable "empty", not a
// non-retryable "content_filter".

const DESCRIPTIVE_POLICY =
  "Content that violates the content policy is removed automatically; you can appeal within 30 days.";

describe("HE-9 — descriptive policy mention is not a refusal", () => {
  it("detectRefusalText: leading descriptive policy clause → NOT a refusal", () => {
    // FAILS on pre-fix code: the bare `\\bviolates the content policy\\b`
    // pattern matched anywhere in the head and flagged this as a refusal.
    expect(detectRefusalText(DESCRIPTIVE_POLICY).isRefusal).toBe(false);
  });

  it("live classifyCodexResponse: descriptive policy answer stays completed (no failover replay)", () => {
    const r = classifyCodexResponse({
      hasText: true,
      hasToolCalls: false,
      responseText: DESCRIPTIVE_POLICY,
      inputTokens: 120,
      outputTokens: 22,
    });
    expect(r.type).toBe("completed");
    expect(r.shouldFallback).toBe(false);
  });

  it("live classifyOpenAIResponse: descriptive policy answer stays completed", () => {
    const r = classifyOpenAIResponse({
      hasText: true,
      hasToolCalls: false,
      finishReason: "stop",
      responseText: DESCRIPTIVE_POLICY,
      outputTokens: 22,
    });
    expect(r.type).toBe("completed");
  });

  it("does NOT over-correct: a policy mention WITH first-person declining framing is still a refusal", () => {
    const genuine =
      "That request goes against my guidelines, so I won't be able to help you with it.";
    expect(detectRefusalText(genuine).isRefusal).toBe(true);
    const r = classifyCodexResponse({
      hasText: true,
      hasToolCalls: false,
      responseText: genuine,
      inputTokens: 120,
      outputTokens: 18,
    });
    expect(r.type).toBe("content_filter");
    expect(r.shouldFallback).toBe(true);
  });

  it("still catches a plain first-person refusal opening", () => {
    expect(detectRefusalText("I cannot help with that request.").isRefusal).toBe(true);
  });
});

describe("HE-9 — zero-token empty on a non-moderating provider is retryable", () => {
  it("live classifyCodexResponse: zero tokens + providerModerates=false → retryable empty, not content_filter", () => {
    // FAILS on pre-fix code: the zero-token default returned content_filter
    // (shouldRetry:false, shouldFallback:true) ungated.
    const r = classifyCodexResponse({
      hasText: false,
      hasToolCalls: false,
      inputTokens: 0,
      outputTokens: 0,
      providerModerates: false,
    });
    expect(r.type).toBe("empty");
    expect(r.shouldRetry).toBe(true);
    expect(r.shouldFallback).toBe(false);
  });

  it("classifyOpenAIResponse: zero tokens + providerModerates=false → retryable empty, not content_filter", () => {
    const r = classifyOpenAIResponse({
      hasText: false,
      hasToolCalls: false,
      inputTokens: 0,
      outputTokens: 0,
      providerModerates: false,
    });
    expect(r.type).toBe("empty");
    expect(r.shouldRetry).toBe(true);
    expect(r.shouldFallback).toBe(false);
  });

  it("preserves the moderating default: zero tokens with providerModerates unset → content_filter", () => {
    const r = classifyOpenAIResponse({
      hasText: false,
      hasToolCalls: false,
      inputTokens: 0,
      outputTokens: 0,
    });
    expect(r.type).toBe("content_filter");
    expect(r.shouldRetry).toBe(false);
  });
});
