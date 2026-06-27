/**
 * The safety hinge for the reasoning_effort 400 retry: the strip-and-retry in
 * openai-http's catch must fire ONLY on the specific "does not support
 * parameter reasoning_effort" 400 and re-throw every other error — otherwise
 * it would mask real OpenAI/OSS failures (rate limit, context length, auth) by
 * silently dropping reasoning_effort.
 */
import { describe, it, expect } from "vitest";
import { isReasoningEffortRejection } from "../src/providers/adapters/openai-http.js";

describe("isReasoningEffortRejection — scopes the reasoning_effort retry", () => {
  it("matches the live xAI rejection (camelCase param in the message)", () => {
    expect(isReasoningEffortRejection("Model grok-4.20-0309-reasoning does not support parameter reasoningEffort.")).toBe(true);
  });

  it("matches the snake_case variant", () => {
    expect(isReasoningEffortRejection("does not support parameter reasoning_effort")).toBe(true);
  });

  it("does NOT match unrelated 400s (they must re-throw, not get masked)", () => {
    expect(isReasoningEffortRejection("Rate limit exceeded")).toBe(false);
    expect(isReasoningEffortRejection("This model's maximum context length is 131072 tokens")).toBe(false);
    expect(isReasoningEffortRejection("Incorrect API key provided")).toBe(false);
    expect(isReasoningEffortRejection("does not support parameter top_k")).toBe(false);
    expect(isReasoningEffortRejection(undefined)).toBe(false);
    expect(isReasoningEffortRejection("")).toBe(false);
  });
});
