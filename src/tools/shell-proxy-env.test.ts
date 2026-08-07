import { describe, it, expect, vi, beforeEach } from "vitest";
import type { SandboxMode } from "../sandbox/index.js";

const sandboxState: { mode: SandboxMode } = { mode: "guarded" };
// `live` mirrors the real singleton's contract: non-null exactly while the
// proxy is up. The mocked ensure sets it on success and clears it on failure.
const proxyState = {
  fail: false,
  // `hang` → the start never resolves on its own (simulates a wedged bind /
  // resolver stall). With `lateRejectMs` set it instead rejects that many ms
  // in — modelling a start that fails only AFTER shellProxyEnv has timed out
  // and stopped awaiting it.
  hang: false,
  lateRejectMs: null as number | null,
  url: "http://127.0.0.1:45678",
  live: null as string | null,
};

vi.mock("../sandbox/index.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../sandbox/index.js")>();
  return {
    ...actual,
    getSandboxMode: () => sandboxState.mode,
  };
});

vi.mock("../net/shell-egress-proxy.js", () => ({
  ensureShellEgressProxy: vi.fn(async () => {
    if (proxyState.hang) {
      proxyState.live = null;
      return new Promise<{ url: string; close: () => Promise<void> }>((_resolve, reject) => {
        if (proxyState.lateRejectMs !== null) {
          setTimeout(() => reject(new Error("late bind failure (test)")), proxyState.lateRejectMs);
        }
        // else: never settles.
      });
    }
    if (proxyState.fail) {
      proxyState.live = null;
      throw new Error("bind failed (test)");
    }
    proxyState.live = proxyState.url;
    return { url: proxyState.url, close: async () => {} };
  }),
  currentShellEgressProxyUrl: () => proxyState.live,
}));

import { ensureShellEgressProxy } from "../net/shell-egress-proxy.js";
import { shellProxyEnv, shellProxyEnvSync } from "./shell-proxy-env.js";
import { buildSanitizedEnv } from "./shell-env.js";

const ensureProxy = vi.mocked(ensureShellEgressProxy);

const ALL_PROXY_KEYS = [
  "HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "http_proxy", "https_proxy", "all_proxy",
] as const;
const NO_PROXY_HOSTS = "localhost,127.0.0.1,::1";

beforeEach(() => {
  sandboxState.mode = "guarded";
  proxyState.fail = false;
  proxyState.hang = false;
  proxyState.lateRejectMs = null;
  proxyState.url = "http://127.0.0.1:45678";
  proxyState.live = null;
  ensureProxy.mockClear();
});

describe("shellProxyEnv", () => {
  it("guarded → all proxy keys point at the proxy URL, NO_PROXY covers loopback", async () => {
    const env = await shellProxyEnv();
    for (const key of ALL_PROXY_KEYS) expect(env[key]).toBe(proxyState.url);
    expect(env.NO_PROXY).toBe(NO_PROXY_HOSTS);
    expect(env.no_proxy).toBe(NO_PROXY_HOSTS);
    expect(Object.keys(env)).toHaveLength(8);
  });

  it.each(["host", "seatbelt", "bwrap", "docker"] as const)(
    "%s → {} (no proxy env outside guarded)",
    async (mode) => {
      sandboxState.mode = mode;
      expect(await shellProxyEnv()).toEqual({});
    },
  );

  it("proxy-start rejection → {} and no throw (fails closed at the cage, not open)", async () => {
    proxyState.fail = true;
    await expect(shellProxyEnv()).resolves.toEqual({});
  });

  // REGRESSION: this is the one unguarded await on the bash hot path. A wedged
  // proxy start (bind hang / resolver stall) must never hold a shell hostage —
  // shellProxyEnv must time out and fail CLOSED to {} within the bound rather
  // than block indefinitely before the tool's own killTimer can fire.
  it("start hangs past the timeout → resolves {} within the bound (never blocks the spawn)", async () => {
    vi.useFakeTimers();
    try {
      proxyState.hang = true;
      const pending = shellProxyEnv();
      // Just before the bound: still awaiting, no premature {}.
      await vi.advanceTimersByTimeAsync(2999);
      // Crossing the 3s bound trips the timeout race.
      await vi.advanceTimersByTimeAsync(1);
      await expect(pending).resolves.toEqual({});
    } finally {
      vi.useRealTimers();
    }
  });

  it("fast path still returns the proxy env even with the timeout armed", async () => {
    // The proxy resolves in microtasks, well inside the bound; the armed timer
    // is cleared and the full 8-key env comes back unchanged.
    const env = await shellProxyEnv();
    for (const key of ALL_PROXY_KEYS) expect(env[key]).toBe(proxyState.url);
    expect(Object.keys(env)).toHaveLength(8);
  });

  // REGRESSION: after a timeout we stop awaiting the start but it keeps warming
  // in the background. A late rejection from that orphaned start must be
  // swallowed — never an unhandled rejection that could crash the process.
  it("late rejection from the backgrounded start (after timeout) never crashes", async () => {
    vi.useFakeTimers();
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown): void => {
      unhandled.push(reason);
    };
    process.on("unhandledRejection", onUnhandled);
    try {
      proxyState.hang = true;
      proxyState.lateRejectMs = 5000; // rejects well after the 3s timeout
      const pending = shellProxyEnv();
      await vi.advanceTimersByTimeAsync(3000);
      await expect(pending).resolves.toEqual({});
      // Drive time past the backgrounded start's late rejection and let any
      // rejection bookkeeping flush.
      await vi.advanceTimersByTimeAsync(3000);
      await Promise.resolve();
      expect(unhandled).toEqual([]);
    } finally {
      process.removeListener("unhandledRejection", onUnhandled);
      vi.useRealTimers();
    }
  });

  it("survives buildSanitizedEnv's scrubbers via the extra overlay", async () => {
    const env = buildSanitizedEnv(await shellProxyEnv());
    expect(env.HTTP_PROXY).toBe(proxyState.url);
    expect(env.https_proxy).toBe(proxyState.url);
    expect(env.all_proxy).toBe(proxyState.url);
    expect(env.NO_PROXY).toBe(NO_PROXY_HOSTS);
  });

  it("caller-explicit values win over the proxy base (merge order semantics)", async () => {
    const merged = buildSanitizedEnv({
      ...(await shellProxyEnv()),
      HTTP_PROXY: "http://custom:9999",
    });
    expect(merged.HTTP_PROXY).toBe("http://custom:9999");
    // Untouched keys keep the proxy value.
    expect(merged.HTTPS_PROXY).toBe(proxyState.url);
  });
});

describe("shellProxyEnvSync", () => {
  it("non-guarded → {}", () => {
    sandboxState.mode = "host";
    expect(shellProxyEnvSync()).toEqual({});
  });

  it("guarded with the proxy up → env derived from the live mirror", async () => {
    await shellProxyEnv(); // warm the proxy
    const env = shellProxyEnvSync();
    for (const key of ALL_PROXY_KEYS) expect(env[key]).toBe(proxyState.url);
    expect(env.no_proxy).toBe(NO_PROXY_HOSTS);
    expect(Object.keys(env)).toHaveLength(8);
  });

  it("cold miss → {} for that spawn, then warms the proxy in the background", async () => {
    expect(shellProxyEnvSync()).toEqual({});
    expect(ensureProxy).toHaveBeenCalledTimes(1);
    // Let the background warm settle (mock resolves in microtasks).
    await new Promise((r) => setImmediate(r));
    expect(shellProxyEnvSync().HTTP_PROXY).toBe(proxyState.url);
  });

  // REGRESSION (skeptic repro, C3 rework): a cached env once outlived the
  // local-only teardown — after close, every spawn kept getting the DEAD
  // port A forever, and the background warm never re-fired because it was
  // gated on the cache being null. The env must be derived from the
  // singleton's live mirror on every call, never stored here.
  it("proxy torn down between spawns → {} (never the dead port), re-warms, then serves the restarted port", async () => {
    const portA = "http://127.0.0.1:41111";
    const portB = "http://127.0.0.1:42222";

    // Warm on ephemeral port A; the sync path serves A.
    proxyState.url = portA;
    await shellProxyEnv();
    expect(shellProxyEnvSync().HTTP_PROXY).toBe(portA);

    // Local-only toggled ON then OFF: closeShellEgressProxy() killed the
    // listener on A and cleared the live mirror; nothing restarted it. A
    // future warm will bind a NEW ephemeral port (B).
    proxyState.live = null;
    proxyState.url = portB;
    ensureProxy.mockClear();

    // The next spawn must NOT be pointed at dead (OS-recyclable) port A...
    expect(shellProxyEnvSync()).toEqual({});
    // ...and must have triggered a background re-warm.
    expect(ensureProxy).toHaveBeenCalledTimes(1);

    // After the restart settles, spawns get port B.
    await new Promise((r) => setImmediate(r));
    const env = shellProxyEnvSync();
    expect(env.HTTP_PROXY).toBe(portB);
    expect(env.https_proxy).toBe(portB);
  });
});
