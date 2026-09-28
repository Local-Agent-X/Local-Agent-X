/**
 * Cross-seam invariant: once context-sizing.ts has applied a size to the chat
 * model, NOTHING that talks to that model asks for another one. Ollama reloads
 * a runner whenever a request's num_ctx differs from the loaded one
 * (server/sched.go needsReload, ollama@16b4376a lines 1390-1438; a request
 * with no num_ctx is compared at the runtime default), so one stray size is a
 * 5-15 s reload of a 17 GB model, and another when chat asks for its size back.
 *
 * Covered paths: the chat request itself (native transport), the chat
 * residency hold, voice-ws's warm (config.ollamaUrl spelling, no size), a
 * background dispatch (llm-dispatch/ollama.ts), the classifier cold-skip warm
 * (classify-with-llm-dispatch.ts) and the /v1 tool-capability probe (which
 * cannot carry a size, so must not fire).
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

// Every URL in this file is a stub target; the global fetch below answers all
// of them, so nothing leaves the process. "localhost" is how config.ollamaUrl
// spells what discovery calls 127.0.0.1.
vi.hoisted(() => { process.env.LAX_OLLAMA_URL = "http://localhost:11499"; });

const { ensureContextDecision, _resetContextSizingForTests, appliedContext } = await import("./context-sizing.js");
const { ContextSizingStore } = await import("./context-sizing-store.js");
const { fakeFetchJson, referenceRuntime, RTX_5090 } = await import("./context-sizing.test-helper.js");
const { holdChatModelResidency, releaseChatModelResidency, warmModel, dispatchNumCtx, _resetResidencyCache } = await import("./residency.js");
const { callOllama } = await import("../llm-dispatch/ollama.js");
const { resolveProviderCall } = await import("../classifiers/classify-with-llm-dispatch.js");
const { maybeVerifyToolSupport } = await import("../providers/tool-capability-probe.js");
const { OllamaNativeAdapter } = await import("../providers/adapters/ollama-native.js");

const ROOT = "http://127.0.0.1:11499";
const MODEL = "qwen3.6:27b";
let dir: string;
let applied: number;
const sizes: Array<{ path: string; numCtx: number | undefined }> = [];
const v1Calls: string[] = [];

function ndjsonDone(): Response {
  return new Response(`${JSON.stringify({ message: { role: "assistant", content: "ok" }, done: true, done_reason: "stop", eval_count: 1 })}\n`);
}

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "lax-invariant-"));
  process.env.LAX_DATA_DIR = dir;
  _resetContextSizingForTests();
  await ensureContextDecision(ROOT, MODEL, {
    deps: {
      fetchJson: fakeFetchJson(referenceRuntime()), gpu: async () => RTX_5090,
      store: new ContextSizingStore(join(dir, "local-context-sizing.json")),
      backgroundModels: async () => [], kvCacheType: () => null, now: () => 1,
    },
  });
  applied = appliedContext(ROOT, MODEL)!;
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    const path = new URL(url).pathname;
    if (path === "/api/ps") return new Response(JSON.stringify({ models: [] })); // cold: nothing loaded
    if (path.endsWith("/chat/completions")) { v1Calls.push(url); return new Response("{}"); }
    const body = JSON.parse(String(init?.body ?? "{}")) as { options?: { num_ctx?: number } };
    sizes.push({ path, numCtx: body.options?.num_ctx });
    return path === "/api/chat" ? ndjsonDone() : new Response(JSON.stringify({ response: "{}" }));
  }));
});

afterAll(() => {
  releaseChatModelResidency();
  vi.unstubAllGlobals();
  delete process.env.LAX_DATA_DIR;
  delete process.env.LAX_OLLAMA_URL;
  rmSync(dir, { recursive: true, force: true });
});

beforeEach(() => {
  sizes.length = 0;
  v1Calls.length = 0;
  _resetResidencyCache();
});

describe("every path to the sized chat model asks for its applied size", () => {
  it("the sizing applied a real size to begin with", () => {
    expect(applied).toBe(180_224); // 27B on the 32 GB card, no background models to leave room for
  });

  it("the chat request (native /api/chat)", async () => {
    for await (const _ of new OllamaNativeAdapter().stream({
      apiKey: "ollama", model: MODEL, baseURL: `${ROOT}/v1`, systemPrompt: "s", messages: [{ role: "user", content: "hi" }], tools: [],
    })) { /* drain */ }
    expect(sizes).toEqual([{ path: "/api/chat", numCtx: applied }]);
  });

  it("the chat residency hold", async () => {
    holdChatModelResidency(ROOT, MODEL);
    await expect.poll(() => sizes.length).toBe(1);
    expect(sizes).toEqual([{ path: "/api/generate", numCtx: applied }]);
  });

  it("voice-ws's unsized warm, through config.ollamaUrl's spelling of the endpoint", async () => {
    warmModel("http://localhost:11499", MODEL);
    await expect.poll(() => sizes.length).toBe(1);
    expect(sizes[0].numCtx).toBe(applied);
  });

  it("a background dispatch to the chat model while it is not loaded", async () => {
    expect(await dispatchNumCtx(ROOT, MODEL, 17e9)).toBe(applied);
    await callOllama("classify this", MODEL, 0, 64, 5_000);
    expect(sizes).toEqual([{ path: "/api/generate", numCtx: applied }]);
  });

  it("the classifier's cold-skip warm", async () => {
    const result = await resolveProviderCall({
      provider: "local", apiKey: "", model: MODEL, systemPrompt: "s", userPrompt: "u", role: "routing",
      maxChars: 100, maxTokens: 32, timeoutMs: 3_000, defaultTimeoutMs: 3_000,
      linkedSignal: new AbortController().signal, certifiedLocalTarget: undefined,
      logger: { info: () => {}, warn: () => {}, debug: () => {}, error: () => {} } as never,
    });
    expect(result.kind).toBe("skip");
    await expect.poll(() => sizes.length).toBe(1);
    expect(sizes[0]).toEqual({ path: "/api/generate", numCtx: applied });
  });

  it("the /v1 tool probe, which cannot carry a size, does not fire", async () => {
    await maybeVerifyToolSupport(`${ROOT}/v1`, MODEL, "ollama");
    expect(v1Calls).toEqual([]);
  });

  it("an unsized model is left alone by every path (no size invented)", async () => {
    warmModel(ROOT, "unsized:7b");
    await expect.poll(() => sizes.length).toBe(1);
    expect(sizes[0].numCtx).toBeUndefined();
  });
});
