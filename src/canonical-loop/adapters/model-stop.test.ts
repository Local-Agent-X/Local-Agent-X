import { describe, expect, it } from "vitest";
import { classifyModelStop, MODEL_REFUSAL_CODE, refusalError } from "./model-stop.js";

describe("model-stop — a provider's refusal is an error the user can see", () => {
  it("names Anthropic's `refusal`, OpenAI-compat's `content_filter` and Gemini's policy stops, nothing else", () => {
    expect(refusalError("refusal")?.code).toBe(MODEL_REFUSAL_CODE);
    expect(refusalError("content_filter")?.code).toBe(MODEL_REFUSAL_CODE);
    expect(refusalError("REFUSAL")?.message).toMatch(/nothing ran/);
    for (const stop of ["SAFETY", "RECITATION", "BLOCKLIST", "PROHIBITED_CONTENT", "SPII", "IMAGE_SAFETY"]) {
      expect(refusalError(stop)?.code, stop).toBe(MODEL_REFUSAL_CODE);
    }
    for (const stop of [
      "end_turn", "stop", "tool_use", "tool_calls", "max_tokens", "length", "", undefined, null,
      "STOP", "MAX_TOKENS", "OTHER", "LANGUAGE", "MALFORMED_FUNCTION_CALL",
    ]) {
      expect(refusalError(stop)).toBeNull();
    }
  });

  it("the loop still treats a refusal as not-a-clean-end", () => {
    expect(classifyModelStop("refusal", 0)).toBe("continue");
    expect(classifyModelStop("end_turn", 0)).toBe("ended");
  });
});

describe("model-stop — a response that called a tool has not ended", () => {
  it("an end-of-turn stop with no tool call is the model ending", () => {
    for (const stop of ["end_turn", "stop", "stop_sequence", "STOP"]) {
      expect(classifyModelStop(stop, 0), stop).toBe("ended");
    }
  });

  it("an end-of-turn stop beside a tool call waits for the result, on every provider's spelling", () => {
    // Codex (Responses "completed" → end_turn), Gemini (STOP), OpenAI-compat ("stop" + tool_calls).
    for (const stop of ["end_turn", "stop", "stop_sequence", "STOP"]) {
      expect(classifyModelStop(stop, 1), stop).toBe("continue");
    }
    expect(classifyModelStop("tool_use", 2)).toBe("continue");
  });

  it("no stop reason stays no signal, tool call or not", () => {
    expect(classifyModelStop(undefined, 1)).toBeUndefined();
    expect(classifyModelStop("", 0)).toBeUndefined();
  });
});
