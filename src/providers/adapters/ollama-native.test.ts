import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ProviderRequest, StreamChunk } from "../adapter/types.js";
import { OllamaNativeAdapter, thinkValue } from "./ollama-native.js";
import { hasNoToolSupport, hasParamUnsupported } from "../types.js";
import { classify } from "../../errors/classifier.js";
import { _resetContextSizingForTests, ensureContextDecision } from "../../local-runtimes/context-sizing.js";
import { ContextSizingStore } from "../../local-runtimes/context-sizing-store.js";
import { _resetModelProfilesForTests } from "../../local-runtimes/model-profile.js";
import { fakeFetchJson, referenceRuntime, RTX_5090 } from "../../local-runtimes/context-sizing.test-helper.js";

const ROOT = "http://127.0.0.1:11434";
let dir: string;
let posts: Array<Record<string, unknown>>;
let psReads: number;
let responses: Array<() => Response>;

/** NDJSON body, optionally torn mid-line across reads like a real socket. */
function ndjson(lines: unknown[], tearAt?: number): Response {
  const text = lines.map((l) => JSON.stringify(l)).join("\n") + "\n";
  const cut = tearAt ?? text.length;
  const enc = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    start(c) {
      c.enqueue(enc.encode(text.slice(0, cut)));
      if (cut < text.length) c.enqueue(enc.encode(text.slice(cut)));
      c.close();
    },
  });
  return new Response(body, { status: 200, headers: { "Content-Type": "application/x-ndjson" } });
}

const done = (extra: Record<string, unknown> = {}) => ({
  message: { role: "assistant", content: "" }, done: true, done_reason: "stop",
  prompt_eval_count: 1200, eval_count: 40, ...extra,
});

function req(over: Partial<ProviderRequest> = {}): ProviderRequest {
  return {
    apiKey: "ollama", model: "qwen3.6:27b", baseURL: `${ROOT}/v1`, systemPrompt: "sys",
    messages: [{ role: "user", content: "hi" }],
    tools: [{ name: "read", description: "r", parameters: { type: "object" } }],
    ...over,
  } as ProviderRequest;
}

async function collect(r: ProviderRequest): Promise<StreamChunk[]> {
  const out: StreamChunk[] = [];
  for await (const c of new OllamaNativeAdapter().stream(r)) out.push(c);
  return out;
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "lax-native-"));
  process.env.LAX_DATA_DIR = dir;
  _resetContextSizingForTests();
  posts = [];
  psReads = 0;
  responses = [];
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    const path = new URL(url).pathname;
    if (path === "/api/ps") { psReads++; return new Response(JSON.stringify({ models: [] })); }
    if (path !== "/api/chat") throw new Error(`unexpected ${url}`);
    posts.push(JSON.parse(String(init?.body)));
    return responses.shift()!();
  }));
});

afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.LAX_DATA_DIR;
  _resetContextSizingForTests();
  rmSync(dir, { recursive: true, force: true });
});

async function sizeTheModel(): Promise<void> {
  await ensureContextDecision(ROOT, "qwen3.6:27b", {
    deps: {
      fetchJson: fakeFetchJson(referenceRuntime()), gpu: async () => RTX_5090,
      store: new ContextSizingStore(join(dir, "local-context-sizing.json")),
      backgroundModels: async () => ["mxbai-embed-large"], kvCacheType: () => null, now: () => 1,
    },
  });
}

describe("OllamaNativeAdapter request", () => {
  it("posts /api/chat with the applied num_ctx, keep_alive and the local output cap", async () => {
    await sizeTheModel();
    responses.push(() => ndjson([{ message: { role: "assistant", content: "ok" }, done: false }, done()]));
    const chunks = await collect(req());
    expect(posts).toHaveLength(1);
    expect(posts[0]).toMatchObject({
      model: "qwen3.6:27b", stream: true, keep_alive: "30m",
      options: { num_ctx: 172_032, num_predict: 16_384, temperature: 0.7 },
    });
    const sent = chunks.find((c) => c.type === "request_sent");
    expect(sent).toMatchObject({ params: { options: { num_ctx: 172_032 }, tools: ["read"] } });
    expect((sent as { params: Record<string, unknown> }).params).not.toHaveProperty("messages");
    // The completed request is observed for verification, off the turn.
    await expect.poll(() => psReads).toBe(1);
  });

  it("sends no num_ctx for a model LAX has not sized, and does not observe it", async () => {
    responses.push(() => ndjson([done()]));
    await collect(req());
    expect(posts[0].options).not.toHaveProperty("num_ctx");
    await new Promise((r) => setTimeout(r, 10));
    expect(psReads).toBe(0);
  });

  it("maps reasoning_effort to think", () => {
    expect(thinkValue(`${ROOT}/v1`, "qwen3.6:27b", "none")).toBe(false);
    expect(thinkValue(`${ROOT}/v1`, "qwen3.6:27b", "high")).toBe(true);
    expect(thinkValue(`${ROOT}/v1`, "gpt-oss:20b", "minimal")).toBe("low");
    expect(thinkValue(`${ROOT}/v1`, "gpt-oss:20b", "high")).toBe("high");
  });

  it.each([
    [true, true],
    [false, undefined],
  ])("replayReasoning %s -> think %s (EXP-36: the template renders a prior <think> only when think is set)", async (replay, think) => {
    mkdirSync(join(dir, "model-profiles"), { recursive: true });
    writeFileSync(join(dir, "model-profiles", "qwen3-8b.json"), JSON.stringify({ replayReasoning: replay }));
    _resetModelProfilesForTests();
    responses.push(() => ndjson([done()]));
    await collect(req({ model: "qwen3:8b" }));
    expect(posts[0].think).toBe(think);
    _resetModelProfilesForTests();
  });

  it("sends think:false for thinking off", async () => {
    responses.push(() => ndjson([done()]));
    await collect(req({ model: "qwen3:8b", reasoningEffort: "none" }));
    expect(posts[0].think).toBe(false);
  });
});

describe("OllamaNativeAdapter stream", () => {
  it("streams text and thinking, survives a line torn across reads, maps usage", async () => {
    responses.push(() => ndjson([
      { message: { role: "assistant", content: "", thinking: "hmm" }, done: false },
      { message: { role: "assistant", content: "Hel" }, done: false },
      { message: { role: "assistant", content: "lo" }, done: false },
      done({ prompt_eval_cached_count: 1100 }),
    ], 30));
    const chunks = await collect(req());
    expect(chunks.filter((c) => c.type === "thinking")).toEqual([{ type: "thinking", delta: "hmm" }]);
    expect(chunks.filter((c) => c.type === "text").map((c) => (c as { delta: string }).delta).join("")).toBe("Hello");
    expect(chunks.find((c) => c.type === "usage")).toEqual({ type: "usage", promptTokens: 1200, completionTokens: 40, cachedTokens: 1100 });
    expect(chunks.at(-1)).toMatchObject({ type: "done", stopReason: "stop" });
    expect((chunks.at(-1) as { firstTokenMs?: number }).firstTokenMs).toBeGreaterThanOrEqual(0);
  });

  it("reports cachedTokens as unknown, not zero, when the runtime does not send the count", async () => {
    responses.push(() => ndjson([done()]));
    const usage = (await collect(req())).find((c) => c.type === "usage") as { cachedTokens?: number };
    expect(usage).toBeDefined();
    expect("cachedTokens" in usage).toBe(false);
  });

  it("gives every tool call a unique, stable, provider-safe id", async () => {
    responses.push(() => ndjson([
      { message: { role: "assistant", content: "", tool_calls: [
        { function: { name: "read", arguments: { path: "a" } } },
        { id: "call_dup", function: { name: "read", arguments: { path: "b" } } },
      ] }, done: false },
      { message: { role: "assistant", content: "", tool_calls: [{ id: "call_dup", function: { name: "glob", arguments: { pattern: "*" } } }] }, done: false },
      done(),
    ]));
    const chunks = await collect(req());
    const calls = chunks.filter((c) => c.type === "tool_call") as Array<{ id: string; name: string; arguments: string }>;
    expect(calls.map((c) => c.name)).toEqual(["read", "read", "glob"]);
    expect(calls[1].id).toBe("call_dup");
    expect(new Set(calls.map((c) => c.id)).size).toBe(3);
    for (const c of calls) expect(c.id).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(JSON.parse(calls[0].arguments)).toEqual({ path: "a" });
    expect(chunks.at(-1)).toMatchObject({ type: "done", stopReason: "tool_calls" });
  });

  it("maps done_reason length", async () => {
    responses.push(() => ndjson([{ message: { role: "assistant", content: "cut" }, done: false }, done({ done_reason: "length" })]));
    expect((await collect(req())).at(-1)).toMatchObject({ type: "done", stopReason: "length" });
  });

  it("stops on abort", async () => {
    const ac = new AbortController();
    responses.push(() => ndjson([{ message: { role: "assistant", content: "a" }, done: false }, done()]));
    const out: StreamChunk[] = [];
    for await (const c of new OllamaNativeAdapter().stream(req({ signal: ac.signal }))) {
      out.push(c);
      if (c.type === "text") ac.abort();
    }
    expect(out.at(-1)).toMatchObject({ type: "done", stopReason: "abort" });
    expect(out.some((c) => c.type === "usage")).toBe(false);
  });
});

describe("OllamaNativeAdapter errors", () => {
  it("surfaces an HTTP error as `<status> <message>` so the shared classifiers still fire", async () => {
    responses.push(() => new Response(JSON.stringify({ error: "the input exceeds the context length of the model" }), { status: 400 }));
    const chunks = await collect(req());
    expect(chunks).toEqual([{ type: "error", message: "400 the input exceeds the context length of the model", statusCode: 400 }]);
    expect(classify(new Error((chunks[0] as { message: string }).message)).reason).toBe("context_overflow");
  });

  it("surfaces an in-stream error line", async () => {
    responses.push(() => ndjson([{ message: { role: "assistant", content: "par" }, done: false }, { error: "model runner has unexpectedly stopped", status: 500 }]));
    const chunks = await collect(req());
    expect(chunks.at(-1)).toEqual({ type: "error", message: "500 model runner has unexpectedly stopped", statusCode: 500 });
  });

  it("surfaces a refused connection", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new TypeError("fetch failed"); }));
    expect(await collect(req())).toEqual([{ type: "error", message: "fetch failed" }]);
  });

  it("self-heals a model without tool support once, and learns it", async () => {
    responses.push(
      () => new Response(JSON.stringify({ error: "registry.ollama.ai/library/tiny:1b does not support tools" }), { status: 400 }),
      () => ndjson([{ message: { role: "assistant", content: "hi" }, done: false }, done()]),
    );
    const chunks = await collect(req({ model: "tiny:1b", baseURL: "http://127.0.0.1:11435/v1" }));
    expect(posts[0]).toHaveProperty("tools");
    expect(posts[1]).not.toHaveProperty("tools");
    expect(chunks.some((c) => c.type === "text")).toBe(true);
    expect(hasNoToolSupport("http://127.0.0.1:11435/v1", "tiny:1b")).toBe(true);
  });

  it("self-heals a model that cannot think, sharing /v1's learned reasoning_effort latch", async () => {
    responses.push(
      () => new Response(JSON.stringify({ error: "\"plain:3b\" does not support thinking" }), { status: 400 }),
      () => ndjson([done()]),
    );
    await collect(req({ model: "plain:3b", baseURL: "http://127.0.0.1:11436/v1", reasoningEffort: "none" }));
    expect(posts[0].think).toBe(false);
    expect(posts[1]).not.toHaveProperty("think");
    expect(hasParamUnsupported("http://127.0.0.1:11436/v1", "plain:3b", "reasoning_effort")).toBe(true);
  });
});
