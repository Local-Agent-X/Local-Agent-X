import { describe, it, expect } from "vitest";
import { shouldForceRecallSearch } from "../src/agent-request/prepare-request.js";
import { providerUndercallsTools } from "../src/providers/provider-ids.js";

// Grok/xAI under-calls tools: it ignores the known-projects recall nudge and
// answers thin instead of fetching prior content via search_past_sessions.
// When the scanner found prior content AND the provider is tool-shy, we force
// the recall tool on turn 0. These tests lock that decision matrix.

const TOOLS = ["read", "search_past_sessions", "memory_search"];

describe("providerUndercallsTools — data-driven tool-shy gate", () => {
  it("xai is tool-shy", () => {
    expect(providerUndercallsTools("xai")).toBe(true);
  });

  it("strong providers are not tool-shy", () => {
    for (const p of ["openai", "anthropic", "codex", "local", "ollama-cloud", "gemini"]) {
      expect(providerUndercallsTools(p)).toBe(false);
    }
  });
});

describe("shouldForceRecallSearch", () => {
  const base = {
    toolAlreadyForced: false,
    knownProjectsFound: true,
    provider: "xai",
    toolNames: TOOLS,
  };

  it("known-project + tool-shy provider + tool available → force", () => {
    expect(shouldForceRecallSearch(base)).toBe(true);
  });

  it("known-project + strong provider → do NOT force (it self-calls)", () => {
    expect(shouldForceRecallSearch({ ...base, provider: "openai" })).toBe(false);
  });

  it("no known-project + tool-shy provider → do NOT force (nothing to fetch)", () => {
    expect(shouldForceRecallSearch({ ...base, knownProjectsFound: false })).toBe(false);
  });

  it("a stronger intent force already pinned a tool → do NOT override", () => {
    expect(shouldForceRecallSearch({ ...base, toolAlreadyForced: true })).toBe(false);
  });

  it("recall tool not in this turn's tool list → do NOT force", () => {
    expect(shouldForceRecallSearch({ ...base, toolNames: ["read", "bash"] })).toBe(false);
  });
});
