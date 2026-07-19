import { describe, it, expect, vi, afterEach } from "vitest";

import { openaiCompatProbe, entryToModel } from "./openai-compat-probe.js";
import type { LocalRuntimeEndpoint } from "./types.js";

const EP: LocalRuntimeEndpoint = { baseUrl: "http://127.0.0.1:1234", origin: "auto" };

function stubFetch(routes: Record<string, unknown>): ReturnType<typeof vi.fn> {
  const spy = vi.fn(async (url: unknown) => {
    const path = new URL(String(url)).pathname;
    if (path in routes) return new Response(JSON.stringify(routes[path]), { status: 200 });
    return new Response("not found", { status: 404 });
  });
  vi.stubGlobal("fetch", spy);
  return spy;
}

afterEach(() => vi.unstubAllGlobals());

describe("entryToModel window honesty", () => {
  it("LM Studio max_context_length is a ceiling — NEVER reported as the window", () => {
    expect(
      entryToModel({ id: "google/gemma-4-e4b", state: "not-loaded", max_context_length: 131072 }),
    ).toEqual({ id: "google/gemma-4-e4b", contextWindow: null, tools: null });
  });

  it("loaded_context_length counts only when state=loaded", () => {
    expect(
      entryToModel({ id: "m", state: "loaded", loaded_context_length: 8192, max_context_length: 131072 }),
    ).toEqual({ id: "m", contextWindow: 8192, tools: null });
    expect(
      entryToModel({ id: "m", state: "not-loaded", loaded_context_length: 8192 }),
    ).toEqual({ id: "m", contextWindow: null, tools: null });
  });

  it("vLLM max_model_len IS the served window", () => {
    expect(entryToModel({ id: "m", max_model_len: 16384 })).toEqual({
      id: "m",
      contextWindow: 16384,
      tools: null,
    });
  });

  it("capabilities tool_use → tools; absent → unknown; malformed → null entry", () => {
    expect(entryToModel({ id: "m", capabilities: ["tool_use"] })?.tools).toBe(true);
    expect(entryToModel({ id: "m", capabilities: [] })?.tools).toBe(false);
    expect(entryToModel({ id: "m" })?.tools).toBeNull();
    expect(entryToModel({ noId: true })).toBeNull();
    expect(entryToModel("garbage")).toBeNull();
  });

  it("runtime-declared embeddings models are dropped (chat picker seam)", () => {
    expect(
      entryToModel({ id: "text-embedding-nomic-embed-text-v1.5", type: "embeddings", max_context_length: 2048 }),
    ).toBeNull();
    // llm/vlm/absent type all pass through — only the authoritative
    // embeddings declaration excludes.
    expect(entryToModel({ id: "m", type: "llm" })).not.toBeNull();
    expect(entryToModel({ id: "m", type: "vlm" })).not.toBeNull();
    expect(entryToModel({ id: "m" })).not.toBeNull();
  });
});

describe("openaiCompatProbe.certificationIdentity", () => {
  it("uses explicit runtime version and model revision when the server supplies both", async () => {
    stubFetch({
      "/version": { version: "0.9.2" },
      "/v1/models": { data: [{ id: "m", revision: "rev-abc" }] },
    });
    expect(await openaiCompatProbe.certificationIdentity!(EP, "m")).toEqual({
      runtimeVersion: "0.9.2",
      modelDigest: "rev-abc",
    });
  });

  it("returns unknown fields when generic OpenAI compatibility exposes no stable identity", async () => {
    stubFetch({ "/v1/models": { data: [{ id: "m" }] } });
    expect(await openaiCompatProbe.certificationIdentity!(EP, "m")).toEqual({
      runtimeVersion: null,
      modelDigest: null,
    });
  });
});

describe("openaiCompatProbe.detect / identify", () => {
  it("detects on a bare /v1/models list", async () => {
    stubFetch({ "/v1/models": { object: "list", data: [{ id: "m" }] } });
    expect(await openaiCompatProbe.detect(EP)).toBe(true);
  });

  it("false on unreachable / non-list — never throws", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("ECONNREFUSED"); }));
    expect(await openaiCompatProbe.detect(EP)).toBe(false);
    stubFetch({ "/v1/models": { unexpected: true } });
    expect(await openaiCompatProbe.detect(EP)).toBe(false);
  });

  it("identify: /api/v0/models → LM Studio; /props → llama.cpp; neither → null", async () => {
    stubFetch({ "/api/v0/models": { object: "list", data: [] } });
    expect(await openaiCompatProbe.identify!(EP)).toBe("LM Studio");
    stubFetch({ "/props": { default_generation_settings: { n_ctx: 4096 } } });
    expect(await openaiCompatProbe.identify!(EP)).toBe("llama.cpp");
    stubFetch({ "/v1/models": { object: "list", data: [] } });
    expect(await openaiCompatProbe.identify!(EP)).toBeNull();
  });

  it("identify + detect on Docker Model Runner's path-prefixed endpoint", async () => {
    const DMR: LocalRuntimeEndpoint = {
      baseUrl: "http://127.0.0.1:12434/engines",
      origin: "auto",
    };
    stubFetch({ "/engines/v1/models": { object: "list", data: [{ id: "ai/smollm2" }] } });
    expect(await openaiCompatProbe.detect(DMR)).toBe(true);
    expect(await openaiCompatProbe.identify!(DMR)).toBe("Docker Model Runner");
    expect(await openaiCompatProbe.listModels(DMR)).toEqual([
      { id: "ai/smollm2", contextWindow: null, tools: null },
    ]);
  });

  it("identify: TGI via /info — needs BOTH model_id and version", async () => {
    stubFetch({
      "/v1/models": { object: "list", data: [{ id: "tgi" }] },
      "/info": { model_id: "HuggingFaceH4/zephyr-7b-beta", version: "3.3.5", sha: "abc" },
    });
    expect(await openaiCompatProbe.identify!(EP)).toBe("Text Generation Inference");
    // A bare {version} shape (vLLM's /version lookalike) must never match.
    stubFetch({ "/info": { version: "0.8.0" } });
    expect(await openaiCompatProbe.identify!(EP)).toBeNull();
  });

  it("identify: Lemonade via /v1/health signature keys — generic {status:'ok'} never matches", async () => {
    stubFetch({
      "/v1/health": {
        status: "ok", model_loaded: "Llama-3.2-1B-Instruct-Hybrid", all_models_loaded: [],
      },
    });
    expect(await openaiCompatProbe.identify!(EP)).toBe("Lemonade");
    stubFetch({ "/v1/health": { status: "ok" } });
    expect(await openaiCompatProbe.identify!(EP)).toBeNull();
  });

  it("identify: LocalAI via its well-known discovery doc", async () => {
    stubFetch({ "/.well-known/localai.json": { version: "v3.7.0", endpoints: {} } });
    expect(await openaiCompatProbe.identify!(EP)).toBe("LocalAI");
  });

  it("identify: LiteLLM via the documented liveness literal — other strings never match", async () => {
    stubFetch({ "/health/liveliness": "I'm alive!" });
    expect(await openaiCompatProbe.identify!(EP)).toBe("LiteLLM");
    stubFetch({ "/health/liveliness": "ok" });
    expect(await openaiCompatProbe.identify!(EP)).toBeNull();
  });

  it("identify: Xinference via owned_by on /v1/models entries; empty list stays generic", async () => {
    stubFetch({
      "/v1/models": {
        object: "list",
        data: [{ id: "qwen2-instruct", object: "model", created: 0, owned_by: "xinference" }],
      },
    });
    expect(await openaiCompatProbe.identify!(EP)).toBe("Xinference");
    stubFetch({ "/v1/models": { object: "list", data: [] } });
    expect(await openaiCompatProbe.identify!(EP)).toBeNull();
    // owned_by from other servers (vLLM says "vllm") is not Xinference.
    stubFetch({ "/v1/models": { object: "list", data: [{ id: "m", owned_by: "vllm" }] } });
    expect(await openaiCompatProbe.identify!(EP)).toBeNull();
  });

  it("identify precedence: a real Lemonade box (prefix-aliased /api/v0/models AND /v1/health) is Lemonade, never LM Studio", async () => {
    // Lemonade serves every endpoint under /v1, /v0, /api/v1, /api/v0
    // (documented), so it ANSWERS LM Studio's signature route — its own
    // /v1/health signature must win. Mislabeling it "LM Studio" would also
    // suppress lmstudio-autostart (which keys on that label).
    stubFetch({
      "/api/v0/models": { object: "list", data: [{ id: "Llama-3.2-1B-Instruct-Hybrid" }] },
      "/v1/health": { status: "ok", model_loaded: "Llama-3.2-1B-Instruct-Hybrid" },
    });
    expect(await openaiCompatProbe.identify!(EP)).toBe("Lemonade");
  });

  it("identify precedence: a real LM Studio shape (no /v1/health) stays LM Studio, ahead of all later checks", async () => {
    // Real LM Studio's documented surface has no /v1/health — the Lemonade
    // check falls through. The /props and /info stubs are synthetic, only
    // there to prove LM Studio still precedes the llama.cpp and TGI checks.
    stubFetch({
      "/api/v0/models": { object: "list", data: [{ id: "google/gemma-4-e4b" }] },
      "/props": { default_generation_settings: { n_ctx: 4096 } },
      "/info": { model_id: "x", version: "y" },
    });
    expect(await openaiCompatProbe.identify!(EP)).toBe("LM Studio");
  });

  it("identify precedence: llama.cpp wins over later checks", async () => {
    stubFetch({
      "/props": { default_generation_settings: { n_ctx: 4096 } },
      "/info": { model_id: "x", version: "y" },
    });
    expect(await openaiCompatProbe.identify!(EP)).toBe("llama.cpp");
  });
});

describe("openaiCompatProbe.defaultPorts", () => {
  it("sweeps the documented defaults — LM Studio, Jan, LiteLLM, GPT4All, text-generation-webui, KoboldCpp, vLLM, llama.cpp, Xinference, Lemonade, SGLang", () => {
    expect(openaiCompatProbe.defaultPorts).toEqual([
      1234, 1337, 4000, 4891, 5000, 5001, 8000, 8080, 9997, 13305, 30000,
    ]);
  });
});

describe("openaiCompatProbe.listModels", () => {
  it("prefers the enhanced /api/v0/models listing; embeddings entries dropped", async () => {
    stubFetch({
      "/api/v0/models": {
        object: "list",
        data: [
          {
            id: "google/gemma-4-e4b", type: "vlm", state: "not-loaded",
            max_context_length: 131072, capabilities: ["tool_use"],
          },
          { id: "text-embedding-nomic-embed-text-v1.5", type: "embeddings", state: "not-loaded", max_context_length: 2048 },
        ],
      },
    });
    expect(await openaiCompatProbe.listModels(EP)).toEqual([
      { id: "google/gemma-4-e4b", contextWindow: null, tools: true },
    ]);
  });

  it("falls back to bare /v1/models when no enhancement exists", async () => {
    stubFetch({ "/v1/models": { object: "list", data: [{ id: "m", max_model_len: 16384 }] } });
    expect(await openaiCompatProbe.listModels(EP)).toEqual([
      { id: "m", contextWindow: 16384, tools: null },
    ]);
  });
});

describe("openaiCompatProbe.probeModel", () => {
  it("llama.cpp /props n_ctx wins (the served, launch-time window)", async () => {
    stubFetch({
      "/props": { default_generation_settings: { n_ctx: 8192 } },
      "/v1/models": { object: "list", data: [{ id: "m" }] },
    });
    expect(await openaiCompatProbe.probeModel(EP, "m")).toEqual({ contextWindow: 8192 });
  });

  it("{} when nothing is knowable", async () => {
    stubFetch({ "/v1/models": { object: "list", data: [{ id: "m" }] } });
    expect(await openaiCompatProbe.probeModel(EP, "m")).toEqual({});
  });
});
