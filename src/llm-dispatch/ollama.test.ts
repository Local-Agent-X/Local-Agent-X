import { describe, it, expect, vi, afterEach } from "vitest";

import { callOllama } from "./ollama.js";
import { DISPATCH_NUM_CTX, MODEL_KEEP_ALIVE } from "../local-runtimes/residency.js";

afterEach(() => vi.unstubAllGlobals());

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
});
