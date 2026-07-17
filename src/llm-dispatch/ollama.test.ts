import { describe, it, expect, vi, afterEach } from "vitest";

import { callOllama } from "./ollama.js";
import { MODEL_KEEP_ALIVE } from "../local-runtimes/residency.js";

afterEach(() => vi.unstubAllGlobals());

describe("callOllama", () => {
  it("posts a single-shot /api/generate body with keep_alive AND num_predict", async () => {
    const spy = vi.fn(async (_url: unknown, _init?: RequestInit) => new Response(JSON.stringify({ response: "YES" }), { status: 200 }));
    vi.stubGlobal("fetch", spy);
    const out = await callOllama("p", "llama3.2:3b", 0, 64, 1000);
    expect(out).toBe("YES");
    expect(String(spy.mock.calls[0][0])).toMatch(/\/api\/generate$/);
    // Exact body shape: keep_alive keeps the utility model warm between
    // classifier calls (cold load burned the whole wallclock before), and
    // num_predict / temperature must survive unchanged next to it.
    const body = JSON.parse(String(spy.mock.calls[0][1]?.body));
    expect(body).toEqual({
      model: "llama3.2:3b",
      prompt: "p",
      stream: false,
      keep_alive: MODEL_KEEP_ALIVE,
      options: { temperature: 0, num_predict: 64 },
    });
  });

  it("null on HTTP error and on thrown fetch — callers degrade, never throw", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("nope", { status: 500 })));
    expect(await callOllama("p", "m", 0, 64, 1000)).toBeNull();
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("ECONNREFUSED"); }));
    expect(await callOllama("p", "m", 0, 64, 1000)).toBeNull();
  });

  it("null on an empty response field", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ response: "" }), { status: 200 })));
    expect(await callOllama("p", "m", 0, 64, 1000)).toBeNull();
  });
});
