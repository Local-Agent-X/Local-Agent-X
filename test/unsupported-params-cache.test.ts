/**
 * Pins the (baseURL, model, param) keying of the unsupported-params cache and
 * its seed. grok-4.20-0309-reasoning 400s on reasoning_effort; the seed lets
 * the first call skip the failed round-trip, and the openai-http catch adds
 * more rejections at runtime. Same per-endpoint keying as the no-tool cache so
 * one endpoint's rejection doesn't poison the same model behind another.
 */
import { describe, it, expect, beforeEach } from "vitest";
import {
  hasParamUnsupported,
  markParamUnsupported,
  _resetUnsupportedParamsForTests,
} from "../src/providers/types.js";

describe("unsupported-params cache — (baseURL, model, param) keying", () => {
  beforeEach(() => _resetUnsupportedParamsForTests());

  it("is seeded with grok-4.20-0309-reasoning rejecting reasoning_effort", () => {
    expect(hasParamUnsupported("https://api.x.ai/v1", "grok-4.20-0309-reasoning", "reasoning_effort")).toBe(true);
  });

  it("records a runtime rejection and reads it back", () => {
    expect(hasParamUnsupported("https://api.x.ai/v1", "grok-4.3", "reasoning_effort")).toBe(false);
    markParamUnsupported("https://api.x.ai/v1", "grok-4.3", "reasoning_effort");
    expect(hasParamUnsupported("https://api.x.ai/v1", "grok-4.3", "reasoning_effort")).toBe(true);
  });

  it("keys by baseURL — the same model on another endpoint is unaffected", () => {
    markParamUnsupported("https://api.x.ai/v1", "grok-4.3", "reasoning_effort");
    expect(hasParamUnsupported("https://other.example/v1", "grok-4.3", "reasoning_effort")).toBe(false);
  });

  it("keys by param — a different param on the same model is unaffected", () => {
    expect(hasParamUnsupported("https://api.x.ai/v1", "grok-4.20-0309-reasoning", "temperature")).toBe(false);
  });

  it("reset restores the seed rather than wiping it", () => {
    markParamUnsupported("https://api.x.ai/v1", "grok-4.3", "reasoning_effort");
    _resetUnsupportedParamsForTests();
    expect(hasParamUnsupported("https://api.x.ai/v1", "grok-4.3", "reasoning_effort")).toBe(false);
    expect(hasParamUnsupported("https://api.x.ai/v1", "grok-4.20-0309-reasoning", "reasoning_effort")).toBe(true);
  });
});
