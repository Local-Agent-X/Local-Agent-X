import { describe, it, expect, vi, beforeEach } from "vitest";

import {
  lookupContextWindow,
  resolveContextWindow,
  DEFAULT_CONTEXT,
  LOCAL_UNKNOWN_CONTEXT,
} from "./model-windows.js";
import type { LocalRuntimeInfo } from "../local-runtimes/types.js";

let runtimes: LocalRuntimeInfo[] = [];

vi.mock("../local-runtimes/index.js", () => ({
  getRuntimeForModel: (m: string) =>
    runtimes.find(r => r.models.some(x => x.id === m)) ?? null,
  getLocalModel: (chatBaseUrl: string, m: string) =>
    runtimes.find(r => r.chatBaseUrl === chatBaseUrl)?.models.find(x => x.id === m) ?? null,
}));

function rt(models: LocalRuntimeInfo["models"]): LocalRuntimeInfo {
  return {
    kind: "ollama",
    id: "ollama@127.0.0.1:11434",
    label: "Ollama",
    endpoint: { baseUrl: "http://127.0.0.1:11434", origin: "auto" },
    chatBaseUrl: "http://127.0.0.1:11434/v1",
    models,
    refreshedAt: 1,
  };
}

beforeEach(() => { runtimes = []; });

describe("lookupContextWindow — local runtime truth beats the 128k default", () => {
  it("returns the probed REAL window for a discovered local model", () => {
    runtimes = [rt([{ id: "qwen3.6:27b", contextWindow: 32_768, tools: true }])];
    expect(lookupContextWindow("qwen3.6:27b")).toBe(32_768);
  });

  it("known-local model with UNKNOWN window gets the conservative floor, never 128k", () => {
    runtimes = [rt([{ id: "google/gemma-4-e4b", contextWindow: null, tools: true }])];
    expect(lookupContextWindow("google/gemma-4-e4b")).toBe(LOCAL_UNKNOWN_CONTEXT);
  });

  it("local ground truth beats name heuristics (a local 'gpt-oss' is not cloud gpt)", () => {
    runtimes = [rt([{ id: "gpt-oss:120b", contextWindow: 32_768, tools: true }])];
    expect(lookupContextWindow("gpt-oss:120b")).toBe(32_768);
  });

  it("exact MODEL_CONTEXTS table still wins over everything (cloud SoT)", () => {
    runtimes = [rt([{ id: "claude-fable-5", contextWindow: 4_096, tools: true }])];
    expect(lookupContextWindow("claude-fable-5")).toBe(1_000_000);
  });

  it("undiscovered models keep the historical fallback chain", () => {
    expect(lookupContextWindow("claude-mystery")).toBe(200_000);
    expect(lookupContextWindow("grok-mystery")).toBe(131_072);
    expect(lookupContextWindow("total-mystery")).toBe(DEFAULT_CONTEXT);
  });
});

// The number alone cannot answer "is this a fact or a placeholder?" — a real
// 8k-ctx gemma and an unloaded 262k qwen both surface as 8192. Callers that
// refuse work (the openai-compat preflight) MUST branch on provenance; the
// absence of it deadlocked local chat on 2026-07-15.
describe("resolveContextWindow — provenance separates measurement from guess", () => {
  it("marks a probed local window as ground truth", () => {
    runtimes = [rt([{ id: "qwen3.6:27b", contextWindow: 262_144, tools: true }])];
    expect(resolveContextWindow("qwen3.6:27b")).toEqual({
      tokens: 262_144,
      provenance: "probed",
    });
  });

  it("marks the unloaded-model floor as a GUESS, not a measurement", () => {
    runtimes = [rt([{ id: "qwen3.6:27b", contextWindow: null, tools: true }])];
    expect(resolveContextWindow("qwen3.6:27b")).toEqual({
      tokens: LOCAL_UNKNOWN_CONTEXT,
      provenance: "floor",
    });
  });

  it("distinguishes a REAL 8,192 window from the 8,192 floor — same integer, opposite meaning", () => {
    runtimes = [rt([{ id: "real-8k", contextWindow: 8_192, tools: true }])];
    const measured = resolveContextWindow("real-8k");

    runtimes = [rt([{ id: "unloaded", contextWindow: null, tools: true }])];
    const guessed = resolveContextWindow("unloaded");

    expect(measured.tokens).toBe(guessed.tokens); // indistinguishable by number
    expect(measured.provenance).toBe("probed");   // ...but not by provenance
    expect(guessed.provenance).toBe("floor");
  });

  it("tags the pinned table as exact and name-matches as heuristic", () => {
    expect(resolveContextWindow("claude-fable-5")).toEqual({
      tokens: 1_000_000,
      provenance: "exact",
    });
    expect(resolveContextWindow("total-mystery")).toEqual({
      tokens: DEFAULT_CONTEXT,
      provenance: "heuristic",
    });
  });

  it("lookupContextWindow stays the number-only view of the same resolution", () => {
    runtimes = [rt([{ id: "qwen3.6:27b", contextWindow: 262_144, tools: true }])];
    expect(lookupContextWindow("qwen3.6:27b")).toBe(resolveContextWindow("qwen3.6:27b").tokens);
  });
});
