import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { isEligibleClassifierModel } from "../src/local-runtimes/classifier-model.js";
import { PROVIDERS } from "../src/providers/registry.js";
import { hasDynamicCatalog } from "../src/providers/background-model.js";

/**
 * Live 2026-07-15: `[classifier.intent] wallclock timeout at 8000ms
 * (provider=local)` on qwen3.6:27b. `local` has no declared registry
 * backgroundModel — none could exist, since any hardcoded local id 404s for a
 * user who hasn't pulled it — so backgroundModelFor() returned the CHAT model
 * and every classifier ran on the 27B, burning the full budget and returning
 * null. The verdict silently never ran, taking the build-intent tool_choice pin
 * with it.
 */
describe("isEligibleClassifierModel — what may auto-serve classifiers", () => {
  it("accepts a small non-reasoning instruct model", () => {
    expect(isEligibleClassifierModel("llama3.2:3b", 2.0e9)).toBe(true);
    expect(isEligibleClassifierModel("gemma3:4b", 3.3e9)).toBe(true);
    expect(isEligibleClassifierModel("qwen2.5:3b", 1.9e9)).toBe(true);
  });

  it("REJECTS embedding models — the smallest thing on the box (the trap)", () => {
    // mxbai-embed-large is 0.67GB: smaller than any chat model, so a naive
    // smallest-wins pick selects it and every classifier call breaks outright.
    // This is the single most important exclusion in the module.
    expect(isEligibleClassifierModel("mxbai-embed-large:latest", 0.67e9)).toBe(false);
    expect(isEligibleClassifierModel("text-embedding-nomic-embed-text-v1.5", 0.3e9)).toBe(false);
    expect(isEligibleClassifierModel("bge-large-en", 0.4e9)).toBe(false);
    expect(isEligibleClassifierModel("all-minilm:latest", 0.05e9)).toBe(false);
  });

  it("REJECTS thinking/reasoning models — they burn the 8s budget (the whole bug)", () => {
    // A small qwen3 is fast on paper and still times out: hybrid thinking is ON
    // by default. Same failure as grok-4.3 reasoning through every call.
    expect(isEligibleClassifierModel("qwen3:1.7b", 1.4e9)).toBe(false);
    expect(isEligibleClassifierModel("qwq:32b", 20e9)).toBe(false);
    expect(isEligibleClassifierModel("deepseek-r1:7b", 4.7e9)).toBe(false);
    expect(isEligibleClassifierModel("some-model-thinking:4b", 3e9)).toBe(false);
  });

  it("REJECTS anything too big to make the budget (incl. the models on this box)", () => {
    expect(isEligibleClassifierModel("qwen3.6:27b", 17.42e9)).toBe(false);
    expect(isEligibleClassifierModel("gpt-oss:120b", 65.37e9)).toBe(false);
  });

  it("REJECTS unknown-size models rather than guessing", () => {
    // LM Studio doesn't report size. An unranked pick could silently be huge —
    // skipping degrades to the caller's fallback, which is the safe status quo.
    expect(isEligibleClassifierModel("google/gemma-4-e4b", undefined)).toBe(false);
    expect(isEligibleClassifierModel("llama3.2:3b", 0)).toBe(false);
  });
});

describe("pickLocalClassifierModel — picks from the real cache", () => {
  beforeEach(() => vi.resetModules());
  afterEach(() => vi.resetModules());

  /** This box's actual inventory as of 2026-07-15, post `ollama pull llama3.2:3b`. */
  const THIS_BOX = [
    {
      models: [
        { id: "mxbai-embed-large:latest", sizeBytes: 0.67e9, contextWindow: null, tools: null },
        { id: "llama3.2:3b", sizeBytes: 2.0e9, contextWindow: null, tools: null },
        { id: "qwen3.6:27b", sizeBytes: 17.42e9, contextWindow: null, tools: null },
        { id: "gpt-oss:120b", sizeBytes: 65.37e9, contextWindow: null, tools: null },
      ],
    },
    { models: [{ id: "google/gemma-4-e4b", sizeBytes: undefined, contextWindow: null, tools: null }] },
  ];

  const withCache = async (runtimes: unknown) => {
    vi.doMock("../src/local-runtimes/cache.js", () => ({ getLocalRuntimes: () => runtimes }));
    return (await import("../src/local-runtimes/classifier-model.js")).pickLocalClassifierModel();
  };

  it("picks llama3.2:3b on this box — NOT the smaller embedding model", async () => {
    expect(await withCache(THIS_BOX)).toBe("llama3.2:3b");
  });

  it("returns null on a cold cache (never blocks a chat turn on discovery)", async () => {
    expect(await withCache(null)).toBeNull();
  });

  it("returns null when nothing is eligible — caller keeps its fallback", async () => {
    // The pre-pull state: only an embedding model and two oversized models.
    const before = [{ models: THIS_BOX[0].models.filter((m) => m.id !== "llama3.2:3b") }];
    expect(await withCache(before)).toBeNull();
  });
});

describe("resolveBackgroundModel — precedence", () => {
  beforeEach(() => vi.resetModules());
  afterEach(() => vi.resetModules());

  it("identifies exactly the dynamic-catalog providers", () => {
    expect(hasDynamicCatalog("local")).toBe(true);
    expect(hasDynamicCatalog("ollama-cloud")).toBe(true);
    for (const p of ["anthropic", "openai", "xai", "gemini", "codex"] as const) {
      expect(hasDynamicCatalog(p)).toBe(false);
    }
  });

  it("leaves every declared-backgroundModel provider untouched", async () => {
    const { resolveBackgroundModel } = await import("../src/providers/background-model.js");
    expect(await resolveBackgroundModel("xai", "grok-4.3")).toBe("grok-4.20-0309-non-reasoning");
    expect(await resolveBackgroundModel("anthropic", "claude-opus-4-8")).toBe("claude-haiku-4-5");
    expect(await resolveBackgroundModel("openai", "o3-pro")).toBe(PROVIDERS.openai.backgroundModel);
  });

  it("honors the localClassifierModel setting above discovery", async () => {
    vi.doMock("../src/settings.js", () => ({ getSetting: () => "my-pinned:1b" }));
    vi.doMock("../src/local-runtimes/index.js", () => ({ pickLocalClassifierModel: () => "llama3.2:3b" }));
    const { resolveBackgroundModel } = await import("../src/providers/background-model.js");
    expect(await resolveBackgroundModel("local", "qwen3.6:27b")).toBe("my-pinned:1b");
  });

  it("auto-picks the discovered model when the setting is empty", async () => {
    vi.doMock("../src/settings.js", () => ({ getSetting: () => "" }));
    vi.doMock("../src/local-runtimes/index.js", () => ({ pickLocalClassifierModel: () => "llama3.2:3b" }));
    const { resolveBackgroundModel } = await import("../src/providers/background-model.js");
    expect(await resolveBackgroundModel("local", "qwen3.6:27b")).toBe("llama3.2:3b");
  });

  it("falls back to the chat model when nothing is pinned or discovered", async () => {
    // The multi-user guarantee: a fresh install with no small model behaves
    // EXACTLY as it does today rather than 404ing on a hardcoded id.
    vi.doMock("../src/settings.js", () => ({ getSetting: () => "" }));
    vi.doMock("../src/local-runtimes/index.js", () => ({ pickLocalClassifierModel: () => null }));
    const { resolveBackgroundModel } = await import("../src/providers/background-model.js");
    expect(await resolveBackgroundModel("local", "qwen3.6:27b")).toBe("qwen3.6:27b");
  });

  it("survives an unreadable settings file / missing discovery", async () => {
    vi.doMock("../src/settings.js", () => ({ getSetting: () => { throw new Error("no settings"); } }));
    vi.doMock("../src/local-runtimes/index.js", () => ({
      pickLocalClassifierModel: () => { throw new Error("no discovery"); },
    }));
    const { resolveBackgroundModel } = await import("../src/providers/background-model.js");
    expect(await resolveBackgroundModel("local", "qwen3.6:27b")).toBe("qwen3.6:27b");
  });
});
