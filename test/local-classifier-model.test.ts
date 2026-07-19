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
    const snapshot = runtimes as { models: { id: string }[] }[] | null;
    vi.doMock("../src/local-runtimes/cache.js", () => ({
      getLocalRuntimes: () => runtimes,
      getRuntimeForModel: (id: string) => snapshot?.find((runtime) => (
        runtime.models.some((model) => model.id === id)
      )) ?? null,
    }));
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

  it("prefers only certified eligible candidates and breaks equal sizes deterministically", async () => {
    const runtimes = [
      {
        id: "runtime-z",
        kind: "ollama",
        endpoint: { baseUrl: "http://127.0.0.1:11434" },
        chatBaseUrl: "http://127.0.0.1:11434/v1",
        models: [
          { id: "small-uncertified:1b", sizeBytes: 1e9 },
          { id: "z-cert:3b", sizeBytes: 3e9 },
        ],
      },
      {
        id: "runtime-a",
        kind: "openai-compat",
        endpoint: { baseUrl: "http://127.0.0.1:1234" },
        chatBaseUrl: "http://127.0.0.1:1234/v1",
        models: [{ id: "a-cert:3b", sizeBytes: 3e9 }],
      },
    ];
    vi.doMock("../src/local-runtimes/cache.js", () => ({
      getLocalRuntimes: () => runtimes,
      getRuntimeForModel: (id: string) => runtimes.find((runtime) => (
        runtime.models.some((model) => model.id === id)
      )) ?? null,
    }));
    vi.doMock("../src/local-runtimes/certification-runner.js", () => ({
      hasPublishedCertification: (_runtime: { id: string }, model: { id: string }) => (
        model.id.endsWith("cert:3b")
      ),
    }));
    const { pickCertifiedLocalClassifierTarget } = await import("../src/local-runtimes/classifier-model.js");
    expect(pickCertifiedLocalClassifierTarget()).toMatchObject({
      runtimeId: "runtime-a",
      chatBaseUrl: "http://127.0.0.1:1234/v1",
      model: "a-cert:3b",
    });
  });

  it("does not treat persistent or failed evidence as a certified routing candidate", async () => {
    const runtimes = [{
      id: "runtime-a",
      kind: "ollama",
      endpoint: { baseUrl: "http://127.0.0.1:11434" },
      chatBaseUrl: "http://127.0.0.1:11434/v1",
      models: [{ id: "candidate:3b", sizeBytes: 3e9 }],
    }];
    vi.doMock("../src/local-runtimes/cache.js", () => ({
      getLocalRuntimes: () => runtimes,
      getRuntimeForModel: (id: string) => runtimes.find((runtime) => (
        runtime.models.some((model) => model.id === id)
      )) ?? null,
    }));
    vi.doMock("../src/local-runtimes/certification-runner.js", () => ({
      hasPublishedCertification: () => false,
    }));
    const { pickCertifiedLocalClassifierTarget } = await import("../src/local-runtimes/classifier-model.js");
    expect(pickCertifiedLocalClassifierTarget()).toBeNull();
  });

  it("preserves the certified runtime when duplicate model IDs exist", async () => {
    const shared = "shared:3b";
    const runtimes = [
      {
        id: "runtime-a", kind: "openai-compat",
        endpoint: { baseUrl: "http://127.0.0.1:1001" },
        chatBaseUrl: "http://127.0.0.1:1001/v1",
        models: [{ id: shared, sizeBytes: 3e9 }],
      },
      {
        id: "runtime-b", kind: "openai-compat",
        endpoint: { baseUrl: "http://127.0.0.1:1002" },
        chatBaseUrl: "http://127.0.0.1:1002/v1",
        models: [{ id: shared, sizeBytes: 3e9 }],
      },
    ];
    vi.doMock("../src/local-runtimes/cache.js", () => ({
      getLocalRuntimes: () => runtimes,
      getRuntimeForModel: (id: string) => runtimes.find((runtime) => (
        runtime.models.some((model) => model.id === id)
      )) ?? null,
    }));
    vi.doMock("../src/local-runtimes/certification-runner.js", () => ({
      hasPublishedCertification: (runtime: { id: string }) => runtime.id === "runtime-b",
    }));
    const {
      pickCertifiedLocalClassifierTarget,
      pickLocalClassifierModel,
    } = await import("../src/local-runtimes/classifier-model.js");
    expect(pickCertifiedLocalClassifierTarget()).toMatchObject({
      runtimeId: "runtime-b",
      chatBaseUrl: "http://127.0.0.1:1002/v1",
      model: shared,
    });
    expect(pickLocalClassifierModel()).toBe(shared);
  });

  it("revalidates cache identity and the current strict-local policy", async () => {
    const runtime = {
      id: "runtime-a",
      kind: "openai-compat" as const,
      label: "LM Studio",
      endpoint: { baseUrl: "http://192.168.1.20:1234", origin: "manual" as const },
      chatBaseUrl: "http://192.168.1.20:1234/v1",
      models: [{ id: "candidate:3b", sizeBytes: 3e9, contextWindow: 8192, tools: true }],
      refreshedAt: 1,
    };
    let current: typeof runtime[] | null = [runtime];
    let strictLocalOnly = false;
    vi.doMock("../src/local-runtimes/cache.js", () => ({
      getLocalRuntimes: () => current,
    }));
    vi.doMock("../src/local-runtimes/certification-runner.js", () => ({
      hasPublishedCertification: () => true,
    }));
    vi.doMock("../src/local-only-policy.js", () => ({
      isLocalOnlyMode: () => strictLocalOnly,
      isLoopbackUrl: (value: string) => ["127.0.0.1", "localhost", "::1"].includes(new URL(value).hostname),
    }));
    const {
      isCertifiedLocalClassifierTargetCurrent,
      pickCertifiedLocalClassifierTarget,
    } = await import("../src/local-runtimes/classifier-model.js");
    const target = pickCertifiedLocalClassifierTarget()!;
    expect(isCertifiedLocalClassifierTargetCurrent(target)).toBe(true);

    current = [{
      ...runtime,
      endpoint: { ...runtime.endpoint },
      models: runtime.models.map((model) => ({ ...model })),
      refreshedAt: 2,
    }];
    expect(isCertifiedLocalClassifierTargetCurrent(target)).toBe(true);

    strictLocalOnly = true;
    expect(isCertifiedLocalClassifierTargetCurrent(target)).toBe(false);
    const loopback = {
      ...runtime,
      id: "runtime-loopback",
      endpoint: { ...runtime.endpoint, baseUrl: "http://127.0.0.1:1234" },
      chatBaseUrl: "http://127.0.0.1:1234/v1",
    };
    current = [loopback];
    const loopbackTarget = pickCertifiedLocalClassifierTarget()!;
    expect(isCertifiedLocalClassifierTargetCurrent(loopbackTarget)).toBe(true);

    strictLocalOnly = false;
    current = [runtime];
    current = [{
      ...current[0],
      endpoint: { ...current[0].endpoint, baseUrl: "http://127.0.0.1:9999" },
      chatBaseUrl: "http://127.0.0.1:9999/v1",
    }];
    expect(isCertifiedLocalClassifierTargetCurrent(target)).toBe(false);
    current = null;
    expect(isCertifiedLocalClassifierTargetCurrent(target)).toBe(false);
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
    expect(await resolveBackgroundModel("xai", "grok-4.3")).toEqual({ model: "grok-4.20-0309-non-reasoning" });
    expect(await resolveBackgroundModel("anthropic", "claude-opus-4-8")).toEqual({ model: "claude-haiku-4-5" });
    expect(await resolveBackgroundModel("openai", "o3-pro")).toEqual({ model: PROVIDERS.openai.backgroundModel });
  });

  it("honors the localClassifierModel setting above discovery", async () => {
    vi.doMock("../src/settings.js", () => ({ getSetting: () => "my-pinned:1b" }));
    vi.doMock("../src/local-runtimes/index.js", () => ({
      pickCertifiedLocalClassifierTarget: () => null,
      pickLocalClassifierModel: () => "llama3.2:3b",
    }));
    const { resolveBackgroundModel } = await import("../src/providers/background-model.js");
    expect(await resolveBackgroundModel("local", "qwen3.6:27b")).toEqual({ model: "my-pinned:1b" });
  });

  it("auto-picks the discovered model when the setting is empty", async () => {
    vi.doMock("../src/settings.js", () => ({ getSetting: () => "" }));
    vi.doMock("../src/local-runtimes/index.js", () => ({
      pickCertifiedLocalClassifierTarget: () => null,
      pickLocalClassifierModel: () => "llama3.2:3b",
    }));
    const { resolveBackgroundModel } = await import("../src/providers/background-model.js");
    expect(await resolveBackgroundModel("local", "qwen3.6:27b")).toEqual({ model: "llama3.2:3b" });
  });

  it("prefers a certified local candidate after an empty setting without changing ollama-cloud", async () => {
    vi.doMock("../src/settings.js", () => ({ getSetting: () => "" }));
    vi.doMock("../src/local-runtimes/index.js", () => ({
      pickCertifiedLocalClassifierTarget: () => ({
        runtimeId: "runtime-a", kind: "ollama", model: "certified:3b",
        endpointBaseUrl: "http://127.0.0.1:11434",
        chatBaseUrl: "http://127.0.0.1:11434/v1",
      }),
      pickLocalClassifierModel: () => "discovered:1b",
    }));
    const { resolveBackgroundModel } = await import("../src/providers/background-model.js");
    const resolved = await resolveBackgroundModel("local", "chat:27b");
    expect(resolved).toMatchObject({
      model: "certified:3b",
      certifiedLocalTarget: { runtimeId: "runtime-a", model: "certified:3b" },
    });
    expect(JSON.stringify(resolved)).not.toMatch(/apiKey|credential|authorization/i);
    expect(await resolveBackgroundModel("ollama-cloud", "chat:27b")).toEqual({ model: "discovered:1b" });
  });

  it("keeps an explicit localClassifierModel above certified routing", async () => {
    let certificationLookups = 0;
    vi.doMock("../src/settings.js", () => ({ getSetting: () => "chosen:1b" }));
    vi.doMock("../src/local-runtimes/index.js", () => ({
      pickCertifiedLocalClassifierTarget: () => { certificationLookups += 1; return null; },
      pickLocalClassifierModel: () => "discovered:1b",
    }));
    const { resolveBackgroundModel } = await import("../src/providers/background-model.js");
    expect(await resolveBackgroundModel("local", "chat:27b")).toEqual({ model: "chosen:1b" });
    expect(certificationLookups).toBe(0);
  });

  it("falls back to the chat model when nothing is pinned or discovered", async () => {
    // The multi-user guarantee: a fresh install with no small model behaves
    // EXACTLY as it does today rather than 404ing on a hardcoded id.
    vi.doMock("../src/settings.js", () => ({ getSetting: () => "" }));
    vi.doMock("../src/local-runtimes/index.js", () => ({
      pickCertifiedLocalClassifierTarget: () => null,
      pickLocalClassifierModel: () => null,
    }));
    const { resolveBackgroundModel } = await import("../src/providers/background-model.js");
    expect(await resolveBackgroundModel("local", "qwen3.6:27b")).toEqual({ model: "qwen3.6:27b" });
  });

  it("survives an unreadable settings file / missing discovery", async () => {
    vi.doMock("../src/settings.js", () => ({ getSetting: () => { throw new Error("no settings"); } }));
    vi.doMock("../src/local-runtimes/index.js", () => ({
      pickCertifiedLocalClassifierTarget: () => { throw new Error("no discovery"); },
      pickLocalClassifierModel: () => { throw new Error("no discovery"); },
    }));
    const { resolveBackgroundModel } = await import("../src/providers/background-model.js");
    expect(await resolveBackgroundModel("local", "qwen3.6:27b")).toEqual({ model: "qwen3.6:27b" });
  });
});
