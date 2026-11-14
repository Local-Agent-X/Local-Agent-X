/**
 * isFrontierModel: who may skip the harness's re-checks once its own check
 * passed. The owner's rule (2026-11-14): local is weak; Claude, GPT, Gemini and
 * Grok are frontier. Their small tiers keep every check, and so does any local
 * or open-weights model, whatever tier its profile declares.
 */
import { describe, expect, it } from "vitest";
import { classifyModel, isFrontierModel } from "./model-tiers.js";

describe("isFrontierModel", () => {
  it("takes each vendor's full-size hosted model", () => {
    for (const m of [
      "claude-opus-5-5", "claude-sonnet-5-5", "claude-fable-5-2", "claude-opus-4-1", "anthropic/claude-opus-5-5",
      "gpt-6.1-sol", "gpt-6.1-terra", "gpt-5.5", "o3", "o4-pro",
      "gemini-3.1-pro-preview", "gemini-4-pro",
      "grok-4.7", "grok-5",
    ]) expect(isFrontierModel(m), m).toBe(true);
  });

  it("leaves out a vendor's small tier, even where classifyModel says strong", () => {
    for (const m of [
      "claude-haiku-5-5", "gpt-5-mini", "gpt-5-nano", "o4-mini",
      "gemini-flash-latest", "gemini-3.1-flash-lite-preview", "grok-4-fast", "grok-3-mini",
    ]) expect(isFrontierModel(m), m).toBe(false);
    expect(classifyModel("claude-haiku-5-5")).toBe("strong");
  });

  it("never takes a local or open-weights model, however big", () => {
    for (const m of ["qwen3:8b", "qwen3-coder:480b", "gpt-oss:120b", "deepseek-v3.1:671b", "sm54/qwen3.6-27b", "llama3.3:70b"]) {
      expect(isFrontierModel(m), m).toBe(false);
    }
  });

  it("leaves out older generations and anything it does not know", () => {
    for (const m of ["gpt-4o", "gemini-2.5-pro", "grok-3", "claude-3-opus-20240229", "mistral-large", "custom-model"]) {
      expect(isFrontierModel(m), m).toBe(false);
    }
  });
});
