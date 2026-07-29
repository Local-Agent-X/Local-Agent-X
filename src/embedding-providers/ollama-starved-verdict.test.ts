// 2026-07-28: the probe LIED. Ollama had been listening on 127.0.0.1:11434
// since the previous morning and GET /api/tags answered 200 with a model
// loaded, yet boot logged "[memory] Ollama not reachable at
// http://127.0.0.1:11434 — keyword search only" and the embed path logged
// "degraded (embed: This operation was aborted)" right after a long stall.
//
// Cause: every deadline on this path is a Node timer, and a timer on a BLOCKED
// event loop fires the instant the loop resumes — aborting a request that was
// never given a millisecond of service, then convicting Ollama for it. Memory
// retrieval silently fell back to keyword-only while the server was up.
//
// These pin both halves of the rule: a deadline is evidence only when this
// process was awake to enforce it, AND a genuinely dead endpoint must STILL be
// reported dead. Every clock here is injected — no wall-clock sleeps.
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { OllamaEmbeddings } from "./ollama.js";
// Static, not dynamic: the boot graph takes seconds to transform, and paying
// that inside a test would time it out instead of measuring it.
import { initOrRefreshEmbeddingProvider } from "../server/bootstrap-services.js";

const { tagsMock, settingsStub } = vi.hoisted(() => ({
  tagsMock: vi.fn(),
  settingsStub: { value: {} as Record<string, unknown> },
}));

vi.mock("../ollama-cloud.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../ollama-cloud.js")>()),
  fetchLocalOllamaTags: tagsMock,
}));

vi.mock("../settings.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../settings.js")>()),
  loadSettings: () => settingsStub.value,
}));

const BASE = "http://127.0.0.1:11434";
const UP = { reachable: true, models: [{ name: "mxbai-embed-large:latest" }] };

function okEmbedResponse(dims = 4): Response {
  return new Response(JSON.stringify({ embeddings: [Array(dims).fill(0.5)] }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

/**
 * Injected monotonic clock. `set` models the loop coming back: a timer armed
 * for `budget` ms fires when the loop resumes, and `now()` then reports how
 * much real time actually elapsed while it was blocked.
 */
function fakeClock() {
  let t = 0;
  return { now: () => t, set: (ms: number) => { t = ms; } };
}

/** A fetch that never answers and only settles when our own deadline aborts
 *  it — at `abortsAtMs` on the injected clock. */
function fetchWedgedUntilAbort(clock: ReturnType<typeof fakeClock>, abortsAtMs: number): typeof fetch {
  return vi.fn((_url, init?: RequestInit) =>
    new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => {
        clock.set(abortsAtMs);
        reject(Object.assign(new Error("This operation was aborted"), { name: "AbortError" }));
      });
    }),
  ) as unknown as typeof fetch;
}

async function makeHealthyProvider(clock: ReturnType<typeof fakeClock>): Promise<OllamaEmbeddings> {
  tagsMock.mockResolvedValue(UP);
  const provider = new OllamaEmbeddings({ baseUrl: BASE, model: "mxbai-embed-large", now: clock.now });
  vi.stubGlobal("fetch", vi.fn(async () => okEmbedResponse()));
  await expect(provider.ensureHealthy()).resolves.toBe(true);
  return provider;
}

describe("OllamaEmbeddings — a starved loop must not convict Ollama", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    tagsMock.mockReset();
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("withholds the verdict when the abort timer only fired because the loop was blocked", async () => {
    const clock = fakeClock();
    const provider = await makeHealthyProvider(clock);

    // The loop is blocked for 92s. The 5s embed deadline fires the moment it
    // resumes, aborting a request Ollama never got to answer.
    vi.stubGlobal("fetch", fetchWedgedUntilAbort(clock, 92_000));
    const pending = provider.embed("query text");
    await vi.advanceTimersByTimeAsync(5_100);
    expect((await pending).every((v) => v === 0)).toBe(true); // this call degrades…

    // …but health is untouched: the very next call goes to the network and
    // gets a real vector. HEAD marked the provider unhealthy here and returned
    // empty vectors for a full 60s recheck window while Ollama was serving.
    const afterStall = vi.fn(async () => okEmbedResponse());
    vi.stubGlobal("fetch", afterStall);
    const vec = await provider.embed("next query");
    expect(afterStall).toHaveBeenCalledTimes(1);
    expect(vec.some((v) => v !== 0)).toBe(true);
  });

  it("still convicts, via the armed recheck, when the outage outlives the stall", async () => {
    // Guard on the other half of the rule: withholding is not "assume fine".
    // The stall hid the truth for one call; the recheck asks again on a live
    // loop, and a real outage is reported then.
    const clock = fakeClock();
    const provider = await makeHealthyProvider(clock);

    vi.stubGlobal("fetch", fetchWedgedUntilAbort(clock, 92_000));
    const pending = provider.embed("query text");
    await vi.advanceTimersByTimeAsync(5_100);
    await pending;

    // Ollama is genuinely gone by the time the recheck runs, and this "no" is
    // rendered inside the probe's own budget — a fair verdict.
    tagsMock.mockImplementation(async () => { clock.set(93_500); return { reachable: false, models: [] }; });
    await vi.advanceTimersByTimeAsync(60_100);
    await vi.runOnlyPendingTimersAsync();

    const afterConviction = vi.fn(async () => okEmbedResponse());
    vi.stubGlobal("fetch", afterConviction);
    expect((await provider.embed("next query")).every((v) => v === 0)).toBe(true);
    expect(afterConviction).not.toHaveBeenCalled();
  });

  it("still convicts a wedged Ollama when the loop was awake the whole time", async () => {
    const clock = fakeClock();
    const provider = await makeHealthyProvider(clock);

    // Deadline fires 4ms past its 5s budget — normal timer jitter, so the
    // silence really is Ollama's.
    vi.stubGlobal("fetch", fetchWedgedUntilAbort(clock, 5_004));
    const pending = provider.embed("query text");
    await vi.advanceTimersByTimeAsync(5_100);
    expect((await pending).every((v) => v === 0)).toBe(true);

    const afterConviction = vi.fn(async () => okEmbedResponse());
    vi.stubGlobal("fetch", afterConviction);
    expect((await provider.embed("next query")).every((v) => v === 0)).toBe(true);
    expect(afterConviction).not.toHaveBeenCalled(); // unhealthy: no network wait
  });

  it("still convicts a refused connection even while the loop is blocked", async () => {
    const clock = fakeClock();
    const provider = await makeHealthyProvider(clock);

    // Ollama is genuinely down: connect is refused immediately. The loop
    // happens to have been blocked too — elapsed time alone must NOT excuse it,
    // because this failure is not our own abort.
    const refused = vi.fn(async () => {
      clock.set(92_000);
      throw new TypeError("fetch failed");
    });
    vi.stubGlobal("fetch", refused);
    expect((await provider.embed("query text")).every((v) => v === 0)).toBe(true);

    const afterConviction = vi.fn(async () => okEmbedResponse());
    vi.stubGlobal("fetch", afterConviction);
    expect((await provider.embed("next query")).every((v) => v === 0)).toBe(true);
    expect(afterConviction).not.toHaveBeenCalled();
  });

  it("re-asks a reachability probe whose 'no' was decided on a blocked loop", async () => {
    const clock = fakeClock();
    tagsMock
      .mockImplementationOnce(async () => { clock.set(92_000); return { reachable: false, models: [] }; })
      .mockImplementation(async () => UP);
    vi.stubGlobal("fetch", vi.fn(async () => okEmbedResponse()));

    const provider = new OllamaEmbeddings({ baseUrl: BASE, model: "mxbai-embed-large", now: clock.now });
    await expect(provider.ensureHealthy()).resolves.toBe(true);
    expect(tagsMock).toHaveBeenCalledTimes(2);
  });

  it("believes an unreachable verdict rendered inside the probe's own budget", async () => {
    const clock = fakeClock();
    // 1.5s == the reachability probe's connect budget: an honest "nothing is
    // listening", not a starved one. No retake, and the provider goes down.
    tagsMock.mockImplementation(async () => { clock.set(1_500); return { reachable: false, models: [] }; });
    vi.stubGlobal("fetch", vi.fn(async () => okEmbedResponse()));

    const provider = new OllamaEmbeddings({ baseUrl: BASE, model: "mxbai-embed-large", now: clock.now });
    await expect(provider.ensureHealthy()).resolves.toBe(false);
    expect(tagsMock).toHaveBeenCalledTimes(1);
  });
});

// Same rule, other door: the boot warmer renders its own "Ollama is
// unreachable" verdict from the same tags probe. This is the seam that
// produced the user-visible ERROR line, so both must apply ONE rule.
describe("boot embedding warmer — one rule at both doors", () => {
  beforeEach(() => {
    tagsMock.mockReset();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("does not drop memory to keyword search on a starved 'unreachable'", async () => {
    const clock = fakeClock();
    settingsStub.value = { embeddingProvider: "ollama", embeddingModel: "mxbai-embed-large", ollamaUrl: BASE };
    tagsMock
      .mockImplementationOnce(async () => { clock.set(92_000); return { reachable: false, models: [] }; })
      .mockImplementation(async () => UP);
    vi.stubGlobal("fetch", vi.fn(async () => okEmbedResponse()));

    const memoryIndex = { setEmbeddingProvider: vi.fn(async () => {}) };
    const result = await initOrRefreshEmbeddingProvider({
      config: {} as never,
      dataDir: "",
      secretsStore: { get: () => undefined, has: () => false } as never,
      memoryIndex: memoryIndex as never,
      now: clock.now,
    });

    expect(result).toMatchObject({ providerName: "ollama", degraded: false });
    expect(memoryIndex.setEmbeddingProvider).toHaveBeenCalledTimes(1);
    expect(tagsMock.mock.calls.length).toBeGreaterThanOrEqual(2); // asked again, on a live loop
  });
});
