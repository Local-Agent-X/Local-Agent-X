import { describe, it, expect, vi, afterEach } from "vitest";

import { isModelResident, warmModel, MODEL_KEEP_ALIVE } from "./residency.js";

const BASE = "http://127.0.0.1:11434";

function psFetch(payload: unknown, status = 200) {
  const spy = vi.fn(async (_url: unknown) => new Response(JSON.stringify(payload), { status }));
  vi.stubGlobal("fetch", spy);
  return spy;
}

const tick = () => new Promise((r) => setTimeout(r, 0));

afterEach(() => vi.unstubAllGlobals());

describe("isModelResident", () => {
  it("true when /api/ps lists the model", async () => {
    const spy = psFetch({ models: [{ name: "llama3.2:3b", model: "llama3.2:3b" }] });
    expect(await isModelResident(BASE, "llama3.2:3b")).toBe(true);
    expect(String(spy.mock.calls[0][0])).toBe(`${BASE}/api/ps`);
  });

  it("false when the model is not among the loaded ones", async () => {
    psFetch({ models: [{ name: "qwen3.6:27b" }] });
    expect(await isModelResident(BASE, "llama3.2:3b")).toBe(false);
  });

  it("false on an empty loaded list — a valid answer, not an unknown", async () => {
    psFetch({ models: [] });
    expect(await isModelResident(BASE, "llama3.2:3b")).toBe(false);
  });

  it("tag variants are different models — never prefix-match", async () => {
    psFetch({ models: [{ name: "llama3.2:3b-instruct" }] });
    expect(await isModelResident(BASE, "llama3.2:3b")).toBe(false);
  });

  it("an untagged name and :latest are the same model (Ollama's own alias)", async () => {
    psFetch({ models: [{ name: "llama3:latest" }] });
    expect(await isModelResident(BASE, "llama3")).toBe(true);
    psFetch({ models: [{ name: "llama3" }] });
    expect(await isModelResident(BASE, "llama3:latest")).toBe(true);
  });

  it("matches on the model field when name differs — both row fields are authoritative", async () => {
    psFetch({ models: [{ name: "friendly-alias", model: "llama3.2:3b" }] });
    expect(await isModelResident(BASE, "llama3.2:3b")).toBe(true);
  });

  it("null on malformed body — cannot-tell is not cold", async () => {
    psFetch({ unexpected: true });
    expect(await isModelResident(BASE, "llama3.2:3b")).toBeNull();
    psFetch("not an object");
    expect(await isModelResident(BASE, "llama3.2:3b")).toBeNull();
  });

  it("null on HTTP error", async () => {
    psFetch({}, 500);
    expect(await isModelResident(BASE, "llama3.2:3b")).toBeNull();
  });

  it("null on unreachable / timeout — never throws", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("ECONNREFUSED"); }));
    expect(await isModelResident(BASE, "llama3.2:3b")).toBeNull();
    const timeoutErr = new Error("The operation was aborted due to timeout");
    timeoutErr.name = "TimeoutError";
    vi.stubGlobal("fetch", vi.fn(async () => { throw timeoutErr; }));
    expect(await isModelResident(BASE, "llama3.2:3b")).toBeNull();
  });

  it("bounds the probe by a caller-passed timeout, not the 2s default", async () => {
    // Simulate a hung socket: the fetch settles ONLY when the abort signal
    // fires. With a 250ms budget the probe must give up (null) well before
    // the 2s default would have — tight-wallclock callers pass a slice of
    // their own budget precisely so a hung /api/ps can't eat it.
    vi.stubGlobal("fetch", vi.fn((_url: unknown, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new Error("TimeoutError")), { once: true });
      }),
    ));
    const t0 = Date.now();
    expect(await isModelResident(BASE, "llama3.2:3b", 250)).toBeNull();
    expect(Date.now() - t0).toBeLessThan(1800); // 2s default would exceed this
  });
});

describe("warmModel", () => {
  it("sends the documented warm shape: empty prompt, no stream, keep_alive", async () => {
    const spy = vi.fn(async (_url: unknown, _init?: RequestInit) => new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", spy);
    warmModel(BASE, "qwen3.6:27b");
    await tick();
    expect(String(spy.mock.calls[0][0])).toBe(`${BASE}/api/generate`);
    const body = JSON.parse(String(spy.mock.calls[0][1]?.body));
    expect(body).toEqual({ model: "qwen3.6:27b", prompt: "", stream: false, keep_alive: MODEL_KEEP_ALIVE });
  });

  it("dedupes concurrent warms per (baseUrl, model); re-arms after settle", async () => {
    let release!: (r: Response) => void;
    const gate = new Promise<Response>((r) => { release = r; });
    const spy = vi.fn(() => gate);
    vi.stubGlobal("fetch", spy);
    warmModel(BASE, "llama3.2:3b");
    warmModel(BASE, "llama3.2:3b");        // same key, still in flight — no second fetch
    warmModel(`${BASE}/`, "llama3.2:3b");  // trailing slash normalizes to the same key
    expect(spy).toHaveBeenCalledTimes(1);
    warmModel(BASE, "other:7b");           // a different model gets its own warm
    expect(spy).toHaveBeenCalledTimes(2);
    release(new Response("{}", { status: 200 }));
    await tick();
    warmModel(BASE, "llama3.2:3b");        // settled — allowed to warm again
    expect(spy).toHaveBeenCalledTimes(3);
    await tick(); // drain the last in-flight entry so nothing leaks across tests
  });

  it("swallows failures — fire-and-forget never throws or rejects", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("ECONNREFUSED"); }));
    expect(() => warmModel(BASE, "x:1b")).not.toThrow();
    await tick();
  });
});
