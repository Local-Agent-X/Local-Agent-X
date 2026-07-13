import { describe, it, expect, vi } from "vitest";
import { confirmSemanticSignals } from "./confirm-gate.js";
import type { ModuleSignal, OrchestratorInput } from "./types.js";

const input: OrchestratorInput = {
  message: "the dev server process died again",
  sessionId: "s1",
  sessionMessages: [],
  timeOfDay: 12,
  dayOfWeek: 1,
};

const sig = (category: string, source = "test"): ModuleSignal => ({
  source,
  signal: `alert for ${category}`,
  priority: 9,
  category,
  confidence: 0.9,
});

describe("confirmSemanticSignals", () => {
  it("passes through untouched when no gated categories are present", async () => {
    const confirm = vi.fn();
    const signals = [sig("emotion"), sig("recall"), sig("correction")];
    const result = await confirmSemanticSignals(signals, input, confirm);
    expect(result.signals).toBe(signals);
    expect(result.dropped).toEqual([]);
    expect(confirm).not.toHaveBeenCalled();
  });

  it("drops a gated signal the LLM calls a false alarm, keeps the rest", async () => {
    const grief = sig("vulnerability", "vulnerability-awareness");
    const contradiction = sig("contradiction", "contradiction-detector");
    const emotion = sig("emotion", "emotional-memory");
    const confirm = vi.fn(async (_msg: string, s: ModuleSignal) =>
      s.category === "vulnerability" ? false : true,
    );
    const result = await confirmSemanticSignals([grief, contradiction, emotion], input, confirm);
    expect(result.signals).toEqual([contradiction, emotion]);
    expect(result.dropped).toEqual([grief]);
    expect(confirm).toHaveBeenCalledTimes(2);
  });

  it("keeps gated signals on null verdict and on confirm errors (fail-open)", async () => {
    const shift = sig("emotion-shift", "emotional-memory");
    const contradiction = sig("contradiction", "contradiction-detector");
    const confirm = vi.fn(async (_msg: string, s: ModuleSignal) => {
      if (s.category === "emotion-shift") return null;
      throw new Error("provider down");
    });
    const result = await confirmSemanticSignals([shift, contradiction], input, confirm);
    expect(result.signals).toEqual([shift, contradiction]);
    expect(result.dropped).toEqual([]);
  });

  it("preserves ordering of non-dropped signals", async () => {
    const a = sig("recall");
    const b = sig("contradiction");
    const c = sig("emotion");
    const confirm = vi.fn(async () => false);
    const result = await confirmSemanticSignals([a, b, c], input, confirm);
    expect(result.signals).toEqual([a, c]);
  });
});
