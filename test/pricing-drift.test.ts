import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  applyDrift, comparePrices, findSourceEntry, parseDefaultCacheRead, parsePriceRows, perMillion, sameRate,
} from "../scripts/pricing-drift.mjs";
import { CACHE_READ_MULTIPLIER, PRICING } from "../src/pricing/model-prices.js";

// A slice of LiteLLM's model_prices_and_context_window.json shape.
const SOURCE = {
  "claude-opus-5-5": {
    litellm_provider: "anthropic", mode: "chat",
    input_cost_per_token: 4e-06, output_cost_per_token: 2e-05, cache_read_input_token_cost: 2e-07,
  },
  "us.anthropic.claude-opus-5-5": {
    litellm_provider: "bedrock_converse",
    input_cost_per_token: 4.4e-06, output_cost_per_token: 2.2e-05, cache_read_input_token_cost: 2.2e-07,
  },
  "xai/grok-4.3": {
    litellm_provider: "xai",
    input_cost_per_token: 1.25e-06, output_cost_per_token: 2.5e-06, cache_read_input_token_cost: 2e-07,
  },
  "gpt-4o": {
    litellm_provider: "openai",
    input_cost_per_token: 2.5e-06, output_cost_per_token: 1e-05,
  },
  "gpt-5.6": {
    litellm_provider: "openai",
    input_cost_per_token: 4e-06, output_cost_per_token: 2e-05, cache_read_input_token_cost: 4e-07,
  },
  "vertex_ai/gemini-3-pro-preview": {
    litellm_provider: "vertex_ai", input_cost_per_token: 2e-06, output_cost_per_token: 1.2e-05,
  },
  "openrouter/google/gemini-3-pro-preview": {
    litellm_provider: "openrouter", input_cost_per_token: 2e-06, output_cost_per_token: 1.2e-05,
  },
  "gemini-2.5-pro": {
    litellm_provider: "vertex_ai-language-models", input_cost_per_token: 9e-06, output_cost_per_token: 9e-05,
  },
  "gemini/gemini-2.5-pro": {
    litellm_provider: "gemini", input_cost_per_token: 1.25e-06, output_cost_per_token: 1e-05,
  },
};

const TABLE = [
  "export const PRICING: Record<string, ModelPricing> = {",
  '  "claude-opus-5-5": { input: 4, output: 20, cacheRead: 0.05 },',
  '  "grok-4.3": { input: 1.25, output: 2.50 },',
  '  "gpt-4o": { input: 2.50, output: 10 },',
  '  "gpt-5.6": { input: 5, output: 30 }, // bare alias routes to Sol',
  '  "gemini-3-pro-preview": { input: 2, output: 12 },',
  '  "gemini-2.5-pro": { input: 1.25, output: 10 },',
  '  "grok-2": { input: 2, output: 10 },',
  '  "llama": { input: 0, output: 0 },',
  "};",
].join("\r\n");

describe("pricing drift — comparison", () => {
  const rows = parsePriceRows(TABLE);
  const result = comparePrices(rows, SOURCE, 0.1);
  const driftOf = (id: string) => result.drift.find((d: { id: string }) => d.id === id);

  it("parses rows (CRLF-safe) including optional cacheRead", () => {
    expect(rows).toHaveLength(8);
    expect(rows[0]).toEqual({ id: "claude-opus-5-5", input: 4, output: 20, cacheRead: 0.05 });
    expect(rows[1]).toEqual({ id: "grok-4.3", input: 1.25, output: 2.5 });
  });

  it("matches a first-party row within float tolerance, converting cacheRead to a multiplier", () => {
    // 2e-07 / 4e-06 = 0.05 — our multiplier, not the absolute per-token rate.
    expect(findSourceEntry(SOURCE, "claude-opus-5-5")).toEqual({
      key: "claude-opus-5-5", rates: { input: 4, output: 20, cacheRead: 0.05 },
    });
    expect(result.matched).toContainEqual({ id: "claude-opus-5-5", key: "claude-opus-5-5" });
    expect(driftOf("claude-opus-5-5")).toBeUndefined();
  });

  it("uses the provider-prefixed first-party key over a plain reseller key", () => {
    expect(result.matched).toContainEqual({ id: "gemini-2.5-pro", key: "gemini/gemini-2.5-pro" });
  });

  it("flags drift on input/output and on the default cache multiplier", () => {
    expect(driftOf("gpt-5.6")).toEqual({
      id: "gpt-5.6", key: "gpt-5.6",
      fields: [
        { field: "input", ours: 5, theirs: 4 },
        { field: "output", ours: 30, theirs: 20 },
      ],
      // 4e-07 / 4e-06 = 0.1 = the default, so the proposal leaves cacheRead off.
      proposed: { input: 4, output: 20 },
    });
    // grok-4.3 has no cacheRead, so it bills the 0.1 default; xAI's is 0.16.
    expect(driftOf("grok-4.3")).toEqual({
      id: "grok-4.3", key: "xai/grok-4.3",
      fields: [{ field: "cacheRead", ours: 0.1, theirs: 0.16 }],
      proposed: { input: 1.25, output: 2.5, cacheRead: 0.16 },
    });
  });

  it("does not compare cacheRead when the source has no cache rate", () => {
    expect(result.matched).toContainEqual({ id: "gpt-4o", key: "gpt-4o" });
  });

  it("ignores reseller-only entries and reports missing rows as unmatched", () => {
    expect(result.unmatched).toEqual([
      { id: "gemini-3-pro-preview", reason: "no first-party entry" },
      { id: "grok-2", reason: "no first-party entry" },
      { id: "llama", reason: "local (free)" },
    ]);
  });

  it("treats disagreeing first-party entries as no confident match", () => {
    const source = {
      "grok-4.3": { litellm_provider: "xai", input_cost_per_token: 3e-06, output_cost_per_token: 1.5e-05 },
      "xai/grok-4.3": SOURCE["xai/grok-4.3"],
    };
    expect(findSourceEntry(source, "grok-4.3")).toEqual({ ambiguous: ["grok-4.3", "xai/grok-4.3"] });
  });

  it("compares with a relative epsilon, not exact floats", () => {
    expect(perMillion(2e-07)).toBe(0.2);
    expect(perMillion(1.1e-06)).toBe(1.1);
    expect(sameRate(0.1 + 0.2, 0.3)).toBe(true);
    expect(sameRate(0, 0)).toBe(true);
    expect(sameRate(4, 4.01)).toBe(false);
  });
});

describe("pricing drift — apply", () => {
  it("rewrites only drifted rows, keeping line endings and trailing comments", () => {
    const { drift } = comparePrices(parsePriceRows(TABLE), SOURCE, 0.1);
    const out = applyDrift(TABLE, drift);
    expect(out).toContain('  "gpt-5.6": { input: 4, output: 20 }, // bare alias routes to Sol\r\n');
    expect(out).toContain('  "grok-4.3": { input: 1.25, output: 2.5, cacheRead: 0.16 },\r\n');
    expect(out).toContain('  "claude-opus-5-5": { input: 4, output: 20, cacheRead: 0.05 },\r\n');
    expect(comparePrices(parsePriceRows(out), SOURCE, 0.1).drift).toEqual([]);
  });
});

describe("pricing drift — the real price module", () => {
  // The script reads the module as text; this pins that parse to the object
  // the app actually bills from, so a reformatted row can't drop out silently.
  const text = readFileSync(fileURLToPath(new URL("../src/pricing/model-prices.ts", import.meta.url)), "utf8");

  it("parses every PRICING row with the rates the app bills", () => {
    const parsed = Object.fromEntries(parsePriceRows(text).map(({ id, ...p }: { id: string }) => [id, p]));
    expect(parsed).toEqual(PRICING);
  });

  it("parses the default cache-read multiplier", () => {
    expect(parseDefaultCacheRead(text)).toBe(CACHE_READ_MULTIPLIER);
  });
});
