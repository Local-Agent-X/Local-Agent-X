import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { OllamaEmbeddings } from "./ollama.js";

// Locks the turn-latency invariant behind the 2026-07-14 hang: a wedged
// Ollama used to block chat prepare for 90s+ (60s lazy health-check inside a
// turn + 30s embed cap + a batch→serial fallback that multiplied one hang
// into minutes). The provider must fail fast, flip unhealthy, and never do
// per-item retries on the failure path.

vi.mock("../ollama-cloud.js", () => ({
  fetchLocalOllamaTags: vi.fn(async () => ({
    reachable: true,
    models: [{ name: "mxbai-embed-large:latest" }],
  })),
}));

const BASE = "http://127.0.0.1:11434";

function okEmbedResponse(dims = 4, count = 1): Response {
  return new Response(
    JSON.stringify({ embeddings: Array.from({ length: count }, () => Array(dims).fill(0.5)) }),
    { status: 200, headers: { "Content-Type": "application/json" } },
  );
}

/** A fetch that never responds but honors AbortSignal — a wedged Ollama. */
function wedgedFetch(): typeof fetch {
  return vi.fn((_url, init?: RequestInit) =>
    new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(new Error("aborted")));
    }),
  ) as unknown as typeof fetch;
}

async function makeHealthyProvider(): Promise<OllamaEmbeddings> {
  const provider = new OllamaEmbeddings({ baseUrl: BASE, model: "mxbai-embed-large" });
  vi.stubGlobal("fetch", vi.fn(async () => okEmbedResponse()));
  await expect(provider.ensureHealthy()).resolves.toBe(true);
  return provider;
}

describe("OllamaEmbeddings fail-fast lifecycle", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("embed() on a wedged server returns empty within the cap and flips unhealthy", async () => {
    const provider = await makeHealthyProvider();
    const wedged = wedgedFetch();
    vi.stubGlobal("fetch", wedged);

    const pending = provider.embed("query text");
    await vi.advanceTimersByTimeAsync(5_100);
    const vec = await pending;
    expect(vec.every((v) => v === 0)).toBe(true);
    expect(wedged).toHaveBeenCalledTimes(1);

    // Unhealthy now: the next call degrades instantly with NO network wait.
    const vec2 = await provider.embed("another query");
    expect(vec2.every((v) => v === 0)).toBe(true);
    expect(wedged).toHaveBeenCalledTimes(1);
  });

  it("embedBatch() failure does NOT retry items serially (the hang amplifier)", async () => {
    const provider = await makeHealthyProvider();
    const wedged = wedgedFetch();
    vi.stubGlobal("fetch", wedged);

    const pending = provider.embedBatch(["a", "b", "c", "d", "e"]);
    await vi.advanceTimersByTimeAsync(20_100);
    const vecs = await pending;
    expect(vecs).toHaveLength(5);
    expect(vecs.every((v) => v.every((n) => n === 0))).toBe(true);
    // One batch request. The old code fell back to 5 sequential embeds,
    // each with its own 30s cap.
    expect(wedged).toHaveBeenCalledTimes(1);
  });

  it("recovers via the background recheck when the server comes back", async () => {
    const provider = await makeHealthyProvider();
    vi.stubGlobal("fetch", wedgedFetch());
    const pending = provider.embed("q");
    await vi.advanceTimersByTimeAsync(5_100);
    await pending; // now unhealthy, recheck scheduled

    vi.stubGlobal("fetch", vi.fn(async () => okEmbedResponse()));
    await vi.advanceTimersByTimeAsync(60_100); // recheck probe fires and succeeds
    await vi.runOnlyPendingTimersAsync();

    const vec = await provider.embed("q2");
    expect(vec.some((v) => v !== 0)).toBe(true);
  });

  it("unknown health never blocks the caller — probe runs in background", async () => {
    const provider = new OllamaEmbeddings({ baseUrl: BASE, model: "mxbai-embed-large" });
    // Probe would take 30s (model load); the embed call must not wait for it.
    vi.stubGlobal("fetch", vi.fn((_url, init?: RequestInit) =>
      new Promise<Response>((resolve, reject) => {
        const t = setTimeout(() => resolve(okEmbedResponse()), 30_000);
        init?.signal?.addEventListener("abort", () => { clearTimeout(t); reject(new Error("aborted")); });
      }),
    ));
    const vec = await provider.embed("first turn query");
    expect(vec.every((v) => v === 0)).toBe(true);
  });

  it("pins the model with keep_alive so it survives idle gaps", async () => {
    const provider = await makeHealthyProvider();
    const spy = vi.fn(async () => okEmbedResponse());
    vi.stubGlobal("fetch", spy);
    await provider.embed("q");
    const init = (spy.mock.calls[0] as unknown[])[1] as RequestInit;
    const body = JSON.parse(init.body as string);
    expect(body.keep_alive).toBe("4h");
  });
});

// The recovery hook is the memory index's only signal that chunks indexed
// vector-less during an outage can be re-embedded NOW rather than at the next
// boot (index-core-reembed.ts). It must fire exactly once per transition into
// healthy, and a subscriber can never affect the provider's own verdict.
describe("OllamaEmbeddings recovery hook", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  /** Injected monotonic clock: a wedged request that aborts with the clock
   *  still at its start time was convicted on an awake loop. */
  function fakeClock() {
    let t = 0;
    return { now: () => t, set: (ms: number) => { t = ms; } };
  }

  /** A fetch that only settles when our deadline aborts it, and reports the
   *  clock at `abortsAtMs` when it does — past the budget by more than timer
   *  jitter means "the loop was blocked", which withholds the verdict. */
  function fetchWedgedUntilAbort(clock: ReturnType<typeof fakeClock>, abortsAtMs: number): typeof fetch {
    return vi.fn((_url, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => {
          clock.set(abortsAtMs);
          reject(new Error("aborted"));
        });
      }),
    ) as unknown as typeof fetch;
  }

  /** Wedge one embed so the provider convicts Ollama and arms its recheck. */
  async function convict(provider: OllamaEmbeddings): Promise<void> {
    vi.stubGlobal("fetch", wedgedFetch());
    const pending = provider.embed("q");
    await vi.advanceTimersByTimeAsync(5_100);
    await pending;
  }

  /** Bring the server back and let the armed recheck probe it. */
  async function recheckSucceeds(): Promise<void> {
    vi.stubGlobal("fetch", vi.fn(async () => okEmbedResponse()));
    await vi.advanceTimersByTimeAsync(60_100);
    await vi.runOnlyPendingTimersAsync();
  }

  it("fires once when the recheck flips unhealthy→healthy, and not on a healthy→healthy recheck", async () => {
    const clock = fakeClock();
    const provider = new OllamaEmbeddings({ baseUrl: BASE, model: "mxbai-embed-large", now: clock.now });
    vi.stubGlobal("fetch", vi.fn(async () => okEmbedResponse()));
    await expect(provider.ensureHealthy()).resolves.toBe(true);
    const recovered = vi.fn();
    provider.onRecovered(recovered);

    await convict(provider);
    expect(recovered).not.toHaveBeenCalled();
    await recheckSucceeds();
    expect(recovered).toHaveBeenCalledTimes(1);

    // healthy→healthy: a deadline that fired only because the loop was blocked
    // withholds the verdict (health stays true) but still arms a recheck. That
    // probe reconfirms a server that never went down — not a recovery.
    vi.stubGlobal("fetch", fetchWedgedUntilAbort(clock, 92_000));
    const stalled = provider.embed("q2");
    await vi.advanceTimersByTimeAsync(5_100);
    await stalled;
    await recheckSucceeds();
    expect(recovered).toHaveBeenCalledTimes(1);
  });

  it("fires on the first successful probe when health was unknown at subscribe time", async () => {
    // Boot order: the memory index attaches (and subscribes) before the
    // warm-up embed kicks the first probe, so unknown→healthy is the
    // transition that covers chunks indexed during that window.
    const provider = new OllamaEmbeddings({ baseUrl: BASE, model: "mxbai-embed-large" });
    const recovered = vi.fn();
    provider.onRecovered(recovered);
    vi.stubGlobal("fetch", vi.fn(async () => okEmbedResponse()));
    await expect(provider.ensureHealthy()).resolves.toBe(true);
    expect(recovered).toHaveBeenCalledTimes(1);
    await expect(provider.ensureHealthy()).resolves.toBe(true); // settled: no probe, no fire
    expect(recovered).toHaveBeenCalledTimes(1);
  });

  it("a throwing listener never touches health, and the disposer stops delivery", async () => {
    const provider = await makeHealthyProvider();
    const recovered = vi.fn(() => { throw new Error("subscriber bug"); });
    const dispose = provider.onRecovered(recovered);

    await convict(provider);
    await recheckSucceeds();
    expect(recovered).toHaveBeenCalledTimes(1);
    // Still healthy after the subscriber threw: the next embed hits the network.
    const live = vi.fn(async () => okEmbedResponse());
    vi.stubGlobal("fetch", live);
    expect((await provider.embed("q3")).some((v) => v !== 0)).toBe(true);
    expect(live).toHaveBeenCalledTimes(1);

    dispose();
    await convict(provider);
    await recheckSucceeds();
    expect(recovered).toHaveBeenCalledTimes(1);
  });
});
