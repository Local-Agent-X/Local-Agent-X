import { describe, it, expect } from "vitest";
import { modelFamilyRiderFor, providerRiderFor } from "./provider-riders.js";

describe("providerRiderFor", () => {
  it("codex gets the codex behavior rider", () => {
    const rider = providerRiderFor("codex");
    expect(rider).toContain("[CODEX BEHAVIOR RIDER");
    expect(rider).toContain("STRUCTURAL AUTH-WALL = STOP");
  });

  it("xai gets the unleashed rider", () => {
    const rider = providerRiderFor("xai");
    expect(rider).toContain("[GROK UNLEASHED");
    expect(rider).toContain("[END GROK UNLEASHED]");
  });

  it("every other provider gets no provider rider", () => {
    for (const p of ["anthropic", "local", "openai", "gemini", "ollama-cloud", "cerebras", "custom", ""]) {
      expect(providerRiderFor(p)).toBe("");
    }
  });
});

describe("modelFamilyRiderFor", () => {
  const BASE_RULES = [
    "TOOL CALLS USE THE NATIVE MECHANISM ONLY",
    "CALL OR ANSWER — NEVER NARRATE",
    "NO CONTROL TOKENS OR REASONING TAGS",
    "ANSWER ONCE, THEN STOP",
  ];
  const REASONING_RULE = "DELIBERATE BRIEFLY, ANSWER FIRST";

  const BASE_ONLY_MODELS = [
    "gemma3:27b",
    "phi4:latest",
    "llama3.2:3b",
    "mistral-small3.2",
    "lmstudio/gemma-3-27b", // runtime-prefixed id still matches by substring
    "granite3.3:8b", // unknown family → base alone
    "", // no model id → still a local turn; base rules apply
  ];
  const REASONING_MODELS = [
    "qwen3:32b",
    "qwen2:7b",
    "deepseek-r1:14b",
    "glm-4.5-air",
    "gpt-oss:20b",
    "lmstudio/qwen3-32b",
    "Qwen3-32B", // detection is case-insensitive
  ];

  it("every local model gets the shared base rules inside the wrapper", () => {
    for (const model of [...BASE_ONLY_MODELS, ...REASONING_MODELS]) {
      const rider = modelFamilyRiderFor(model);
      expect(rider.startsWith("\n\n[LOCAL MODEL RIDER")).toBe(true);
      expect(rider.endsWith("[END LOCAL MODEL RIDER]\n")).toBe(true);
      for (const rule of BASE_RULES) expect(rider).toContain(rule);
    }
  });

  it("non-reasoning and unknown families get the base alone", () => {
    for (const model of BASE_ONLY_MODELS) {
      expect(modelFamilyRiderFor(model)).not.toContain(REASONING_RULE);
    }
  });

  it("reasoning families get the deliberate-briefly addition", () => {
    for (const model of REASONING_MODELS) {
      expect(modelFamilyRiderFor(model)).toContain(REASONING_RULE);
    }
  });

  it("a compound id matching multiple family substrings gets the addition exactly once", () => {
    const rider = modelFamilyRiderFor("deepseek-r1-distill-qwen-14b");
    const hits = rider.split(REASONING_RULE).length - 1;
    expect(hits).toBe(1);
  });

  it("size guard: the whole rider stays small — these ship to small-context models", () => {
    // Every rider token displaces user context on a small local model. Fails
    // when someone bloats base+family past ~2000 chars (~500 tokens) — trim
    // or split before raising this.
    for (const model of [...BASE_ONLY_MODELS, ...REASONING_MODELS, "deepseek-r1-distill-qwen-14b"]) {
      expect(modelFamilyRiderFor(model).length).toBeLessThan(2000);
    }
  });
});
