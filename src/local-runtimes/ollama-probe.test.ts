import { describe, it, expect, vi, afterEach } from "vitest";

import {
  ollamaProbe,
  parseNumCtx,
  parseToolCapability,
  parseLoadedContext,
} from "./ollama-probe.js";
import type { LocalRuntimeEndpoint } from "./types.js";

const EP: LocalRuntimeEndpoint = { baseUrl: "http://127.0.0.1:11434", origin: "auto" };

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

describe("parseNumCtx", () => {
  it("extracts num_ctx from the whitespace-aligned parameters string", () => {
    expect(parseNumCtx("temperature 1\nnum_ctx                          8192\ntop_k 20")).toBe(8192);
  });
  it("returns null when absent, malformed, or non-string", () => {
    expect(parseNumCtx("temperature 1\ntop_k 20")).toBeNull();
    expect(parseNumCtx("num_ctx abc")).toBeNull();
    expect(parseNumCtx(undefined)).toBeNull();
    expect(parseNumCtx(42)).toBeNull();
  });
});

describe("parseToolCapability", () => {
  it("true when capabilities includes tools, false when present without", () => {
    expect(parseToolCapability(["completion", "vision", "tools", "thinking"])).toBe(true);
    expect(parseToolCapability(["completion"])).toBe(false);
  });
  it("null (unknown, not false) when capabilities is absent", () => {
    expect(parseToolCapability(undefined)).toBeNull();
    expect(parseToolCapability("tools")).toBeNull();
  });
});

describe("parseLoadedContext", () => {
  it("finds the loaded model's served window", () => {
    const ps = { models: [{ name: "qwen3.6:27b", context_length: 32768 }] };
    expect(parseLoadedContext(ps, "qwen3.6:27b")).toBe(32768);
  });
  it("null for unloaded model / malformed ps", () => {
    expect(parseLoadedContext({ models: [] }, "x")).toBeNull();
    expect(parseLoadedContext({}, "x")).toBeNull();
    expect(parseLoadedContext(null, "x")).toBeNull();
  });
});

describe("ollamaProbe.detect", () => {
  it("true on /api/version, false on unreachable — never throws", async () => {
    stubFetch({ "/api/version": { version: "0.32.0" } });
    expect(await ollamaProbe.detect(EP)).toBe(true);
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("ECONNREFUSED"); }));
    expect(await ollamaProbe.detect(EP)).toBe(false);
  });
});

describe("ollamaProbe.listModels", () => {
  it("maps /api/tags with null window/tools (unknown until probed)", async () => {
    stubFetch({ "/api/tags": { models: [{ name: "qwen3.6:27b", size: 17e9, modified_at: "2026-07-15" }] } });
    const models = await ollamaProbe.listModels(EP);
    expect(models).toEqual([
      { id: "qwen3.6:27b", contextWindow: null, tools: null, sizeBytes: 17e9, modifiedAt: "2026-07-15" },
    ]);
  });
  it("[] on unreachable / malformed — never throws, never guesses", async () => {
    stubFetch({ "/api/tags": { unexpected: true } });
    expect(await ollamaProbe.listModels(EP)).toEqual([]);
  });
});

describe("ollamaProbe.probeModel", () => {
  it("loaded /api/ps window beats Modelfile num_ctx; arch max never used", async () => {
    stubFetch({
      "/api/ps": { models: [{ name: "m", context_length: 32768 }] },
      "/api/show": {
        parameters: "num_ctx                          8192",
        capabilities: ["completion", "tools"],
        model_info: { "qwen35.context_length": 262144 },
      },
    });
    expect(await ollamaProbe.probeModel(EP, "m")).toEqual({ contextWindow: 32768, tools: true });
  });

  it("falls back to Modelfile num_ctx when not loaded", async () => {
    stubFetch({
      "/api/ps": { models: [] },
      "/api/show": { parameters: "num_ctx   4096", capabilities: ["completion"] },
    });
    expect(await ollamaProbe.probeModel(EP, "m")).toEqual({ contextWindow: 4096, tools: false });
  });

  it("{} when nothing is known — null never becomes an optimistic default", async () => {
    stubFetch({ "/api/ps": { models: [] }, "/api/show": { model_info: { "q.context_length": 262144 } } });
    expect(await ollamaProbe.probeModel(EP, "m")).toEqual({});
  });
});

describe("ollamaProbe.chatExtraBody", () => {
  it("{} — Ollama /v1 drops options.num_ctx (measured); we never ship a no-op param", () => {
    expect(ollamaProbe.chatExtraBody("m", 4096)).toEqual({});
  });
});
