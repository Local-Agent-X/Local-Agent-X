import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  applyWindowDrift, compareWindows, findSourceWindow, formatTokens, parseWindowRows, sameWindow, upstreamModelsMissing,
} from "../scripts/model-windows-drift.mjs";

// A slice of LiteLLM's model_prices_and_context_window.json shape, as of the
// 2026-09-27 read: gpt-5.6 carries the window minus the output cap, gpt-5.4
// the whole window; grok-4.5 disagrees with x.ai's own docs (1M).
const SOURCE = {
  "claude-opus-5-5": { litellm_provider: "anthropic", mode: "chat", max_input_tokens: 1_000_000, max_output_tokens: 128_000 },
  "claude-haiku-4-5": { litellm_provider: "anthropic", mode: "chat", max_input_tokens: 200_000, max_output_tokens: 64_000 },
  "claude-mythos-5": { litellm_provider: "anthropic", mode: "chat", max_input_tokens: 1_000_000, max_output_tokens: 128_000 },
  "claude-opus-5-5-20260901": { litellm_provider: "anthropic", mode: "chat", max_input_tokens: 1_000_000 },
  "claude-opus-4-1": { litellm_provider: "anthropic", mode: "chat", max_input_tokens: 200_000, deprecation_date: "2026-06-09" },
  "claude-mythos-preview": { litellm_provider: "anthropic", mode: "chat", max_input_tokens: 1_000_000 },
  "us.anthropic.claude-opus-5-5": { litellm_provider: "bedrock_converse", mode: "chat", max_input_tokens: 500_000 },
  "gpt-5.6": { litellm_provider: "openai", mode: "chat", max_input_tokens: 922_000, max_output_tokens: 128_000 },
  "gpt-5.4": { litellm_provider: "openai", mode: "chat", max_input_tokens: 1_050_000, max_output_tokens: 128_000 },
  "gpt-5.4-pro": { litellm_provider: "openai", mode: "responses", max_input_tokens: 1_050_000, max_output_tokens: 128_000 },
  "gpt-5.4-2026-03-05": { litellm_provider: "openai", mode: "chat", max_input_tokens: 1_050_000 },
  "gpt-4o-audio-preview": { litellm_provider: "openai", mode: "chat", max_input_tokens: 128_000 },
  "text-embedding-3-large": { litellm_provider: "openai", mode: "embedding", max_input_tokens: 8_191 },
  "xai/grok-4.5": { litellm_provider: "xai", mode: "chat", max_input_tokens: 500_000 },
  "xai/grok-4.7": { litellm_provider: "xai", mode: "chat", max_input_tokens: 500_000 },
  "xai/grok-4.7-beta": { litellm_provider: "xai", mode: "chat", max_input_tokens: 500_000 },
  "gemini/gemini-2.5-pro": { litellm_provider: "gemini", mode: "chat", max_input_tokens: 1_048_576, max_output_tokens: 65_536 },
  "gemini-2.5-pro": { litellm_provider: "vertex_ai-language-models", mode: "chat", max_input_tokens: 999 },
  "gemini/gemini-3.5-flash": { litellm_provider: "gemini", mode: "chat", max_input_tokens: 1_048_576 },
  "gemini/gemini-3-pro-image": { litellm_provider: "gemini", mode: "chat", max_input_tokens: 65_536 },
  "vertex_ai/gemini-3-pro-preview": { litellm_provider: "vertex_ai", mode: "chat", max_input_tokens: 1_048_576 },
};

const TABLE = [
  "const MODEL_CONTEXTS: Record<string, number> = {",
  '  "claude-opus-5-5": 1_000_000,',
  '  "claude-haiku-4-5": 200_000, // base window',
  '  "gpt-5.6": 1_050_000,      // bare alias routes to Sol',
  '  "gpt-5.4": 272_000,',
  '  "grok-4.5": 1_000_000, // pin: x.ai docs 2026-09-27 say 1M; LiteLLM carries 500k',
  '  "gemini-2.5-pro": 1_048_576,',
  '  "gemini-3-pro-preview": 1_048_576,',
  "};",
  "",
  "export const DEFAULT_CONTEXT = 128_000;",
].join("\r\n");

describe("model windows drift — comparison", () => {
  const rows = parseWindowRows(TABLE);
  const result = compareWindows(rows, SOURCE);

  it("parses rows (CRLF-safe), underscores and pins included", () => {
    expect(rows).toHaveLength(7);
    expect(rows[0]).toEqual({ id: "claude-opus-5-5", tokens: 1_000_000, pinned: false });
    expect(rows[4]).toEqual({ id: "grok-4.5", tokens: 1_000_000, pinned: true });
    // The DEFAULT_CONTEXT line outside the block is not a row.
    expect(rows.some((r) => r.id === "DEFAULT_CONTEXT")).toBe(false);
  });

  it("matches the first-party entry and ignores a reseller's window", () => {
    expect(findSourceWindow(SOURCE, "claude-opus-5-5")).toEqual({ key: "claude-opus-5-5", maxInput: 1_000_000, maxOutput: 128_000 });
    expect(findSourceWindow(SOURCE, "gemini-2.5-pro")).toEqual({ key: "gemini/gemini-2.5-pro", maxInput: 1_048_576, maxOutput: 65_536 });
    expect(result.matched).toContainEqual({ id: "claude-opus-5-5", key: "claude-opus-5-5" });
    expect(result.matched).toContainEqual({ id: "gemini-2.5-pro", key: "gemini/gemini-2.5-pro" });
  });

  it("accepts either of LiteLLM's two window conventions", () => {
    // 1,050,000 = 922,000 + 128,000: the whole-window figure matches a row
    // that stores input-only.
    expect(sameWindow(1_050_000, { maxInput: 922_000, maxOutput: 128_000 })).toBe(true);
    expect(sameWindow(922_000, { maxInput: 922_000, maxOutput: 128_000 })).toBe(true);
    expect(sameWindow(1_000_000, { maxInput: 922_000, maxOutput: 128_000 })).toBe(false);
    expect(result.matched).toContainEqual({ id: "gpt-5.6", key: "gpt-5.6" });
  });

  it("flags drift with the proposal, and never a pinned row", () => {
    expect(result.drift).toEqual([
      { id: "gpt-5.4", key: "gpt-5.4", ours: 272_000, theirs: "1050000 (+128000 output)", proposed: 1_050_000 },
    ]);
    expect(result.pinned).toEqual([
      { id: "grok-4.5", key: "xai/grok-4.5", ours: 1_000_000, theirs: "500000" },
    ]);
  });

  it("reports rows with no first-party entry as unmatched", () => {
    expect(result.unmatched).toEqual([{ id: "gemini-3-pro-preview", reason: "no first-party entry" }]);
  });

  it("treats disagreeing first-party entries as no confident match", () => {
    const source = {
      "grok-4.5": { litellm_provider: "xai", max_input_tokens: 1_000_000 },
      "xai/grok-4.5": SOURCE["xai/grok-4.5"],
    };
    expect(findSourceWindow(source, "grok-4.5")).toEqual({ ambiguous: ["grok-4.5", "xai/grok-4.5"] });
  });
});

describe("model windows drift — apply", () => {
  it("rewrites only drifted rows in the table's own style, keeping comments and pins", () => {
    const { drift } = compareWindows(parseWindowRows(TABLE), SOURCE);
    const out = applyWindowDrift(TABLE, drift);
    expect(formatTokens(1_048_576)).toBe("1_048_576");
    expect(out).toContain('  "gpt-5.4": 1_050_000,\r\n');
    expect(out).toContain('  "gpt-5.6": 1_050_000,      // bare alias routes to Sol\r\n');
    expect(out).toContain('  "grok-4.5": 1_000_000, // pin: x.ai docs 2026-09-27 say 1M; LiteLLM carries 500k\r\n');
    expect(out).toContain("export const DEFAULT_CONTEXT = 128_000;");
    expect(compareWindows(parseWindowRows(out), SOURCE).drift).toEqual([]);
  });
});

describe("upstream models LAX does not list", () => {
  const known = new Set(["claude-opus-5-5", "claude-haiku-4-5", "gpt-5.6", "gpt-5.4", "grok-4.5", "gemini-2.5-pro"]);

  it("names current-generation chat ids only: no snapshots, betas, previews without a version, modality variants, embeddings, resellers or retired ids", () => {
    expect(upstreamModelsMissing(SOURCE, known, { today: "2026-09-27" })).toEqual([
      { provider: "anthropic", id: "claude-mythos-5", maxInput: 1_000_000 },
      { provider: "gemini", id: "gemini-3.5-flash", maxInput: 1_048_576 },
      { provider: "openai", id: "gpt-5.4-pro", maxInput: 1_050_000 },
      { provider: "xai", id: "grok-4.7", maxInput: 500_000 },
    ]);
  });

  it("keeps a deprecated id until its date has passed", () => {
    const ids = upstreamModelsMissing(SOURCE, known, { today: "2026-06-01" }).map((m) => m.id);
    expect(ids).toContain("claude-opus-4-1");
  });

  it("scopes to the providers asked for", () => {
    expect(upstreamModelsMissing(SOURCE, known, { providers: ["xai"], today: "2026-09-27" })).toEqual([
      { provider: "xai", id: "grok-4.7", maxInput: 500_000 },
    ]);
  });
});

describe("the real table", () => {
  it("parses every MODEL_CONTEXTS row of src/context-manager/model-windows.ts", () => {
    const text = readFileSync(fileURLToPath(new URL("../src/context-manager/model-windows.ts", import.meta.url)), "utf8");
    const rows = parseWindowRows(text);
    expect(rows.length).toBeGreaterThan(30);
    expect(rows.find((r) => r.id === "grok-4.5")).toEqual({ id: "grok-4.5", tokens: 1_000_000, pinned: true });
    expect(rows.find((r) => r.id === "claude-opus-5-5")).toEqual({ id: "claude-opus-5-5", tokens: 1_000_000, pinned: false });
  });
});
