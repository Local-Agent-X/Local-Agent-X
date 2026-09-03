// Locks the Claude Sonnet 5 wiring. The load-bearing invariant is the
// adaptive-thinking gate: Sonnet 5 rejects budget_tokens/temperature with a
// 400, and the Anthropic request layer keys off anthropicUsesAdaptiveThinking
// to pick the request shape. If that regex ever drops sonnet-5, every Sonnet 5
// call 400s in production while unit-per-module tests stay green.

import { describe, it, expect } from "vitest";
import { normalizeAnthropicModel, anthropicUsesAdaptiveThinking, anthropicThinkingOffMode, anthropicMaxOutputTokens, anthropicEffortLevels, resolveAnthropicEffort } from "./anthropic-models.js";
import { classifyModel } from "./model-tiers.js";
import { PROVIDERS } from "./providers/registry.js";

describe("Claude Sonnet 5 wiring", () => {
  it("uses the adaptive-thinking request shape (the 400 guard)", () => {
    expect(anthropicUsesAdaptiveThinking("claude-sonnet-5")).toBe(true);
    expect(anthropicUsesAdaptiveThinking("anthropic/claude-sonnet-5")).toBe(true);
    expect(anthropicUsesAdaptiveThinking("claude-sonnet-5[1m]")).toBe(true);
  });

  it("does NOT misclassify sonnet-4-x as adaptive via the sonnet-5 rule", () => {
    expect(anthropicUsesAdaptiveThinking("claude-sonnet-4-5")).toBe(false);
  });

  it("normalizes aliases to the canonical id", () => {
    expect(normalizeAnthropicModel("claude-sonnet-5")).toBe("claude-sonnet-5");
    expect(normalizeAnthropicModel("anthropic/claude-sonnet-5")).toBe("claude-sonnet-5");
    expect(normalizeAnthropicModel("claude-sonnet-5[1m]")).toBe("claude-sonnet-5");
    expect(normalizeAnthropicModel("Claude-Sonnet-5")).toBe("claude-sonnet-5");
  });

  it("classifies as a strong tool-use tier", () => {
    expect(classifyModel("claude-sonnet-5")).toBe("strong");
  });
});

describe("Claude Opus 5 wiring", () => {
  it("uses the adaptive-thinking request shape (the 400 guard)", () => {
    expect(anthropicUsesAdaptiveThinking("claude-opus-5")).toBe(true);
    expect(anthropicUsesAdaptiveThinking("anthropic/claude-opus-5")).toBe(true);
    expect(anthropicUsesAdaptiveThinking("claude-opus-5[1m]")).toBe(true);
  });

  // The opus-5 branch sits next to opus-4-[678] in the same alternation, so the
  // regression to guard is opus-5 swallowing 4.5 (a legacy-shape model that
  // still needs budget_tokens/temperature) or the 4.x ids losing their shape.
  it("does NOT misclassify opus-4-5 as adaptive via the opus-5 rule", () => {
    expect(anthropicUsesAdaptiveThinking("claude-opus-4-5")).toBe(false);
  });

  it("keeps the 4.8/4.7 adaptive shape intact", () => {
    expect(anthropicUsesAdaptiveThinking("claude-opus-4-8")).toBe(true);
    expect(anthropicUsesAdaptiveThinking("claude-opus-4-7")).toBe(true);
  });

  it("normalizes aliases to the canonical id", () => {
    expect(normalizeAnthropicModel("claude-opus-5")).toBe("claude-opus-5");
    expect(normalizeAnthropicModel("anthropic/claude-opus-5")).toBe("claude-opus-5");
    expect(normalizeAnthropicModel("claude-opus-5[1m]")).toBe("claude-opus-5");
    expect(normalizeAnthropicModel("Claude-Opus-5")).toBe("claude-opus-5");
  });

  it("does not rewrite 4.8 — it is still an active model, not retired", () => {
    expect(normalizeAnthropicModel("claude-opus-4-8")).toBe("claude-opus-4-8");
  });

  it("classifies as a strong tool-use tier", () => {
    expect(classifyModel("claude-opus-5")).toBe("strong");
  });
});

// The disableThinking wire-shape map. Omission is NOT a universal off-switch:
// Opus 5 / Sonnet 5 run adaptive when `thinking` is omitted, so only the
// explicit disabled block turns thinking off there; Fable 5 / Mythos 5 reject
// even that (thinking is always on). If a model drifts to the wrong bucket,
// either requests 400 (disabled sent to Fable 5) or a latency-sensitive path
// silently pays thinking again (omission sent to Opus 5 / Sonnet 5).
describe("anthropicThinkingOffMode — per-model disableThinking wire shape", () => {
  it("always-on: Fable 5 / Mythos 5 cannot turn thinking off", () => {
    expect(anthropicThinkingOffMode("claude-fable-5")).toBe("always-on");
    expect(anthropicThinkingOffMode("anthropic/claude-fable-5")).toBe("always-on");
    expect(anthropicThinkingOffMode("claude-fable-5[1m]")).toBe("always-on");
    expect(anthropicThinkingOffMode("claude-mythos-5")).toBe("always-on");
  });

  it("disabled-block: Opus 5 / Sonnet 5 (omission = adaptive ON) and Opus 4.7/4.8 (documented explicit off)", () => {
    for (const m of ["claude-opus-5", "claude-sonnet-5", "claude-opus-4-7", "claude-opus-4-8"]) {
      expect(anthropicThinkingOffMode(m)).toBe("disabled-block");
    }
    expect(anthropicThinkingOffMode("claude-opus-5[1m]")).toBe("disabled-block");
    expect(anthropicThinkingOffMode("anthropic/claude-sonnet-5")).toBe("disabled-block");
  });

  it("omit: 4.6 generation and legacy models turn thinking off by leaving the param out", () => {
    for (const m of [
      "claude-opus-4-6", "claude-sonnet-4-6",
      "claude-opus-4-5", "claude-sonnet-4-5", "claude-haiku-4-5",
    ]) {
      expect(anthropicThinkingOffMode(m)).toBe("omit");
    }
  });

  // Same alternation-anchor regression guarded on anthropicUsesAdaptiveThinking:
  // claude-opus-4-5 must not be swallowed by the opus-5 branch.
  it("does NOT misclassify opus-4-5 via the opus-5 branch", () => {
    expect(anthropicThinkingOffMode("claude-opus-4-5")).toBe("omit");
  });
});

describe("anthropicMaxOutputTokens — per-model output ceiling (single source of truth)", () => {
  it("returns 128K for the current Opus/Sonnet/Fable tiers, incl. Opus 5", () => {
    for (const m of [
      "claude-opus-5", "claude-opus-4-8", "claude-opus-4-6",
      "claude-sonnet-5", "claude-sonnet-4-6", "claude-fable-5",
    ]) {
      expect(anthropicMaxOutputTokens(m)).toBe(128_000);
    }
  });

  it("returns 64K for Haiku 4.5 (the one current model with a lower cap)", () => {
    expect(anthropicMaxOutputTokens("claude-haiku-4-5")).toBe(64_000);
  });

  it("resolves aliases before looking up the ceiling", () => {
    expect(anthropicMaxOutputTokens("anthropic/claude-opus-5")).toBe(128_000);
    expect(anthropicMaxOutputTokens("claude-opus-5[1m]")).toBe(128_000);
    expect(anthropicMaxOutputTokens("Claude-Opus-5")).toBe(128_000);
  });

  it("falls back to the 8192 floor for unknown / pre-4.5 ids — never truncates worse than the old default", () => {
    expect(anthropicMaxOutputTokens("claude-opus-4-0")).toBe(8_192);
    expect(anthropicMaxOutputTokens("some-unknown-model-xyz")).toBe(8_192);
  });

  it("is never below the legacy 8192 for any input (regression: the fix must not lower a ceiling)", () => {
    for (const m of ["claude-opus-5", "claude-haiku-4-5", "claude-opus-4-0", "", "garbage"]) {
      expect(anthropicMaxOutputTokens(m)).toBeGreaterThanOrEqual(8_192);
    }
  });
});

// claude-sonnet-4-7 never existed: the Sonnet line went 4.5 → 4.6 → 5, and the
// 4.7/4.8 generation is Opus-only. The tables briefly listed it anyway, which
// made normalizeAnthropicModel MANUFACTURE the phantom runtime id from user
// input ("claude-sonnet-4.7" → "claude-sonnet-4-7" → wire 404) — the one thing
// the "normalization never invents a model" contract forbids. Pin its absence
// from every table, and pin that the registry catalog carries no phantom: every
// offered id is a runtime id with a real per-model output ceiling.
describe("phantom claude-sonnet-4-7 stays out of the model tables", () => {
  it("normalization passes the unknown id through untouched instead of inventing a runtime id", () => {
    expect(normalizeAnthropicModel("claude-sonnet-4-7")).toBe("claude-sonnet-4-7");
    expect(normalizeAnthropicModel("claude-sonnet-4.7")).toBe("claude-sonnet-4.7");
    expect(normalizeAnthropicModel("anthropic/claude-sonnet-4.7")).toBe("claude-sonnet-4.7");
  });

  it("gets the unknown-model output floor, not a real model's 128K ceiling", () => {
    expect(anthropicMaxOutputTokens("claude-sonnet-4-7")).toBe(8_192);
  });

  it("its real neighbors keep their ceilings (removal touched only the phantom)", () => {
    expect(anthropicMaxOutputTokens("claude-sonnet-4-6")).toBe(128_000);
    expect(anthropicMaxOutputTokens("claude-sonnet-4-5")).toBe(128_000);
  });

  it("the registry catalog never offered it, and every offered id is a real runtime id", () => {
    const catalog = PROVIDERS.anthropic.models;
    expect(catalog).not.toContain("claude-sonnet-4-7");
    for (const id of catalog) {
      expect(normalizeAnthropicModel(id)).toBe(id);
      expect(anthropicMaxOutputTokens(id)).toBeGreaterThan(8_192);
    }
  });
});

// output_config.effort — the third axis of the capability map. Two API facts
// are load-bearing: the parameter ERRORS outright on Sonnet 4.5 / Haiku 4.5,
// and `xhigh` did not exist before Opus 4.7. Both must be omissions, not 400s.
describe("anthropicEffortLevels — per-model output_config.effort support", () => {
  it.each(["claude-fable-5", "claude-mythos-5", "claude-opus-5", "claude-opus-4-8", "claude-opus-4-7", "claude-sonnet-5"])(
    "%s: accepts all five levels including xhigh",
    (model) => {
      expect(anthropicEffortLevels(model)).toEqual(["low", "medium", "high", "xhigh", "max"]);
    },
  );

  it.each(["claude-opus-4-6", "claude-sonnet-4-6"])(
    "%s: no xhigh — that level arrived with Opus 4.7",
    (model) => {
      expect(anthropicEffortLevels(model)).toEqual(["low", "medium", "high", "max"]);
      expect(anthropicEffortLevels(model)).not.toContain("xhigh");
    },
  );

  it("opus-4-5: low/medium/high only", () => {
    expect(anthropicEffortLevels("claude-opus-4-5")).toEqual(["low", "medium", "high"]);
  });

  // The parameter is an ERROR on these — nothing is sendable.
  it.each(["claude-sonnet-4-5", "claude-haiku-4-5", "some-unknown-model"])(
    "%s: no effort support at all",
    (model) => {
      expect(anthropicEffortLevels(model)).toEqual([]);
    },
  );

  // Same anchored-alternation regression the adaptive/off-mode maps guard:
  // opus-4-5 must not be swallowed by the opus-5 or opus-4-[78] branches.
  it("opus-4-5 is not captured by the opus-5 / opus-4-[78] branches", () => {
    expect(anthropicEffortLevels("claude-opus-4-5")).not.toContain("max");
    expect(anthropicEffortLevels("claude-opus-5")).toContain("max");
  });

  it("resolves through aliases and the anthropic/ prefix", () => {
    expect(anthropicEffortLevels("anthropic/claude-opus-5")).toContain("xhigh");
    expect(anthropicEffortLevels("claude-opus-5[1m]")).toContain("xhigh");
  });
});

describe("resolveAnthropicEffort — what may actually go on the wire", () => {
  it("passes a supported level through unchanged", () => {
    expect(resolveAnthropicEffort("claude-opus-5", "low")).toBe("low");
    expect(resolveAnthropicEffort("claude-sonnet-5", "xhigh")).toBe("xhigh");
  });

  it("omits when the caller set nothing", () => {
    expect(resolveAnthropicEffort("claude-opus-5", undefined)).toBeUndefined();
  });

  it("omits (never 400s) on a model without effort support", () => {
    expect(resolveAnthropicEffort("claude-sonnet-4-5", "low")).toBeUndefined();
    expect(resolveAnthropicEffort("claude-haiku-4-5", "high")).toBeUndefined();
  });

  it("omits xhigh on the 4.6 generation but keeps the levels it does accept", () => {
    expect(resolveAnthropicEffort("claude-sonnet-4-6", "xhigh")).toBeUndefined();
    expect(resolveAnthropicEffort("claude-sonnet-4-6", "max")).toBe("max");
  });

  // Opus 5 / Sonnet 5 / Opus 4.7/4.8 accept thinking:{disabled} ONLY at effort
  // high or below — xhigh/max with a disabled block is a 400. The pair must be
  // defused by dropping effort (omission = the API default "high", legal),
  // never by sending it and losing the turn.
  it.each(["claude-opus-5", "claude-sonnet-5", "claude-opus-4-7", "claude-opus-4-8"])(
    "%s: drops xhigh/max when thinking is disabled, keeps high and below",
    (model) => {
      expect(resolveAnthropicEffort(model, "xhigh", true)).toBeUndefined();
      expect(resolveAnthropicEffort(model, "max", true)).toBeUndefined();
      expect(resolveAnthropicEffort(model, "high", true)).toBe("high");
      expect(resolveAnthropicEffort(model, "low", true)).toBe("low");
    },
  );

  it("leaves xhigh/max alone when thinking is NOT being disabled", () => {
    expect(resolveAnthropicEffort("claude-opus-5", "xhigh", false)).toBe("xhigh");
    expect(resolveAnthropicEffort("claude-opus-5", "max")).toBe("max");
  });

  // Fable 5 / Mythos 5 cannot disable thinking at all, so no ceiling applies —
  // the flag is already inert there and must not silently cost effort too.
  it("always-on models keep their effort even when disableThinking is set", () => {
    expect(resolveAnthropicEffort("claude-fable-5", "max", true)).toBe("max");
    expect(resolveAnthropicEffort("claude-mythos-5", "xhigh", true)).toBe("xhigh");
  });
});
