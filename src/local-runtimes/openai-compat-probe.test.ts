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
});

describe("openaiCompatProbe.listModels", () => {
  it("prefers the enhanced /api/v0/models listing (live LM Studio shape)", async () => {
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
      { id: "text-embedding-nomic-embed-text-v1.5", contextWindow: null, tools: null },
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
