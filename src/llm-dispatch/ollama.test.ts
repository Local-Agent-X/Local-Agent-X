import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";

import { callOllama, summarizeOllamaUsage } from "./ollama.js";
import { DISPATCH_NUM_CTX, MODEL_KEEP_ALIVE, _resetResidencyCache } from "../local-runtimes/residency.js";

afterEach(() => vi.unstubAllGlobals());
// Residency probes are cached for ~1s so one dispatch doesn't ask /api/ps
// twice; each case scripts its own /api/ps answer for the same base URL.
beforeEach(() => _resetResidencyCache());

/** /api/ps answers with `loaded`; /api/generate answers with `response`. */
function ollamaFetch(loaded: Array<Record<string, unknown>>, response = "YES") {
  const spy = vi.fn(async (url: unknown, _init?: RequestInit) =>
    String(url).endsWith("/api/ps")
      ? new Response(JSON.stringify({ models: loaded }), { status: 200 })
      : new Response(JSON.stringify({ response }), { status: 200 }));
  vi.stubGlobal("fetch", spy);
  return spy;
}

const generateBody = (spy: ReturnType<typeof ollamaFetch>) =>
  JSON.parse(String(spy.mock.calls.find((c) => String(c[0]).endsWith("/api/generate"))?.[1]?.body));

describe("callOllama", () => {
  it("posts a single-shot /api/generate body with keep_alive AND num_predict", async () => {
    const spy = ollamaFetch([{ name: "llama3.2:3b", context_length: DISPATCH_NUM_CTX }]);
    const out = await callOllama("p", "llama3.2:3b", 0, 64, 1000);
    expect(out).toBe("YES");
    // keep_alive keeps the utility model warm between classifier calls (cold
    // load burned the whole wallclock before).
    expect(generateBody(spy)).toEqual({
      model: "llama3.2:3b",
      prompt: "p",
      stream: false,
      keep_alive: MODEL_KEEP_ALIVE,
      options: { temperature: 0, num_predict: 64, num_ctx: DISPATCH_NUM_CTX },
    });
  });

  it("reuses the loaded context of a model someone is chatting with — never reloads it smaller", async () => {
    // op-outcomes baseline 2026-09-15: the classifier fell back to the 17GB
    // chat model, a fixed num_ctx 16384 reloaded it, and the chat preflight
    // refused turns against the shrunken 16k window.
    const spy = ollamaFetch([{ name: "muse-glimmer:30b", context_length: 65_536 }]);
    await callOllama("p", "muse-glimmer:30b", 0, 64, 1000);
    expect(generateBody(spy).options.num_ctx).toBe(65_536);
  });

  it("leaves an unloaded, undiscovered model at the runtime default instead of guessing a size", async () => {
    const spy = ollamaFetch([]);
    await callOllama("p", "muse-glimmer:30b", 0, 64, 1000);
    expect(generateBody(spy).options).toEqual({ temperature: 0, num_predict: 64 });
  });

  it("null on HTTP error and on thrown fetch — callers degrade, never throw", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("nope", { status: 500 })));
    expect(await callOllama("p", "m", 0, 64, 1000)).toBeNull();
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("ECONNREFUSED"); }));
    expect(await callOllama("p", "m", 0, 64, 1000)).toBeNull();
  });

  it("null on an empty response field", async () => {
    ollamaFetch([], "");
    expect(await callOllama("p", "m", 0, 64, 1000)).toBeNull();
  });

  it("still returns the text when Ollama's counters ride along", async () => {
    vi.stubGlobal("fetch", vi.fn(async (url: unknown) =>
      String(url).endsWith("/api/ps")
        ? new Response(JSON.stringify({ models: [] }), { status: 200 })
        : new Response(JSON.stringify({ response: "YES", prompt_eval_count: 19, eval_count: 2, load_duration: 2_000_000 }), { status: 200 })));
    expect(await callOllama("p", "m", 0, 64, 1000)).toBe("YES");
  });
});

// Ollama returns its per-request counters in nanoseconds; a load past a second
// inside a background call is the context-size ping-pong (or an eviction)
// showing itself where it happens.
describe("summarizeOllamaUsage", () => {
  it("converts the nanosecond counters to milliseconds and spots a (re)load", () => {
    expect(summarizeOllamaUsage({
      prompt_eval_count: 1411, eval_count: 12,
      prompt_eval_duration: 472_440_000, eval_duration: 160_000_000, load_duration: 9_334_000_000,
    })).toEqual({ promptEvalCount: 1411, evalCount: 12, promptEvalMs: 472, evalMs: 160, loadMs: 9334, reloaded: true });
    expect(summarizeOllamaUsage({ prompt_eval_count: 19, eval_count: 2, load_duration: 2_000_000 })?.reloaded).toBe(false);
  });

  it("is null when the response carries no counters", () => {
    expect(summarizeOllamaUsage({ response: "YES" })).toBeNull();
  });
});

describe("callOllama waits for the foreground op on the same model", () => {
  it("defers a side call while a chat op leases the model, and runs it once the op is done", async () => {
    const { runAsForegroundOp, _resetForegroundLeasesForTests } = await import("./foreground-model-lease.js");
    _resetForegroundLeasesForTests();
    const spy = ollamaFetch([{ name: "qwen3.6:27b", context_length: 65536 }]);
    const events: string[] = [];
    const opDone = runAsForegroundOp({ id: "op1", lane: "interactive", model: "qwen3.6:27b" }, async () => {
      await new Promise((r) => setTimeout(r, 300));
      events.push("op-finished");
    });
    const side = callOllama("classify this", "qwen3.6:27b", 0, 16, 5_000).then((r) => { events.push("side-call-returned"); return r; });
    await Promise.all([opDone, side]);
    expect(events).toEqual(["op-finished", "side-call-returned"]);
    expect(spy.mock.calls.some((c) => String(c[0]).endsWith("/api/generate"))).toBe(true);
  });
});
