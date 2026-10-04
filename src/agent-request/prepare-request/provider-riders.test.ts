import { describe, it, expect } from "vitest";
import { codexBehaviorRider, grokUnleashedRider, modelFamilyRiderFor, providerRiderFor } from "./provider-riders.js";

describe("providerRiderFor", () => {
  it("codex gets the codex behavior rider", () => {
    const rider = providerRiderFor("codex");
    expect(rider).toContain("[CODEX BEHAVIOR RIDER");
    expect(rider).toBe(codexBehaviorRider());
  });

  it("xai gets the unleashed rider", () => {
    const rider = providerRiderFor("xai");
    expect(rider).toContain("[GROK UNLEASHED");
    expect(rider).toContain("[END GROK UNLEASHED]");
    expect(rider).toBe(grokUnleashedRider());
  });

  it("every other provider gets no provider rider", () => {
    for (const p of ["anthropic", "local", "openai", "gemini", "ollama-cloud", "cerebras", "custom", ""]) {
      expect(providerRiderFor(p)).toBe("");
    }
  });
});

describe("codexBehaviorRider — a login page is page-scoped (C6)", () => {
  // Motivating bug: user asked for 3 sites on provider=codex; site 1 needed a
  // login and the model halted the whole turn, never opening sites 2-3. Then
  // a login-wall detector fired on a signed-in Twilio console (2026-10-03).
  // The rule keys on the password-field refusal, not a guess about the page.
  const rider = codexBehaviorRider();

  it("never instructs a turn-ending STOP, and no longer keys on a detector marker", () => {
    expect(rider).not.toMatch(/On that signal: STOP/);
    expect(rider).not.toContain("AUTH-WALL");
  });

  it("points a password to the vault fill or the user, and continues the rest of the request", () => {
    expect(rider).toContain("You cannot type into a password field");
    expect(rider).toContain("browser_fill_from_secret");
    expect(rider).toContain("NOT THE END OF THE TURN");
    expect(rider).toContain("CONTINUE with every other part of the request");
  });

  it("keeps the anti-grind and safety guidance for a login page", () => {
    expect(rider).toContain("Do not spend snapshot/extract calls deciding whether a page is a login page");
    expect(rider).toContain("double-check the URL is the real site");
  });

  it("rules 2-6 are untouched", () => {
    for (const heading of [
      "2. **NEVER TYPE PASSWORDS YOURSELF**",
      "3. **READ-THEN-ACT DISCIPLINE**",
      "4. **DON'T PRETEND TO HAVE CAPABILITIES YOU LACK**",
      "5. **SECURITY-CAUTIOUS BY DEFAULT**",
      "6. **INTERLEAVE PER-STEP OUTPUT WHEN ASKED; DON'T BATCH.**",
    ]) {
      expect(rider).toContain(heading);
    }
  });
});

describe("grokUnleashedRider — unaffected by the C6 codex change", () => {
  const rider = grokUnleashedRider();

  it("keeps its structure and key rules", () => {
    expect(rider).toContain("[GROK UNLEASHED — behavioral mode, follow strictly]");
    expect(rider).toContain("1. **No corporate hedging.**");
    expect(rider).toContain("6. **Hard lines still apply:**");
    expect(rider).toContain("E. **A successful tool result is TERMINAL");
    expect(rider).toContain("[END GROK UNLEASHED]");
  });

  it("never mentions auth-walls — that rule is codex-only", () => {
    expect(rider).not.toContain("AUTH-WALL");
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
