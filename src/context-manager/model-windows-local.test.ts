import { describe, it, expect, vi, beforeEach } from "vitest";

import { lookupContextWindow, DEFAULT_CONTEXT, LOCAL_UNKNOWN_CONTEXT } from "./model-windows.js";
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
