import { describe, it, expect, vi, beforeEach } from "vitest";
import type { SandboxMode } from "../sandbox/index.js";

const sandboxState: { mode: SandboxMode } = { mode: "guarded" };
const proxyState = { fail: false, url: "http://127.0.0.1:45678" };

vi.mock("../sandbox/index.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../sandbox/index.js")>();
  return {
    ...actual,
    getSandboxMode: () => sandboxState.mode,
  };
});

vi.mock("../net/shell-egress-proxy.js", () => ({
  ensureShellEgressProxy: vi.fn(async () => {
    if (proxyState.fail) throw new Error("bind failed (test)");
    return { url: proxyState.url, close: async () => {} };
  }),
}));

import { shellProxyEnv, shellProxyEnvSync } from "./shell-proxy-env.js";
import { buildSanitizedEnv } from "./shell-env.js";

const ALL_PROXY_KEYS = [
  "HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "http_proxy", "https_proxy",
] as const;
const NO_PROXY_HOSTS = "localhost,127.0.0.1,::1";

beforeEach(() => {
  sandboxState.mode = "guarded";
  proxyState.fail = false;
});

describe("shellProxyEnv", () => {
  it("guarded → all proxy keys point at the proxy URL, NO_PROXY covers loopback", async () => {
    const env = await shellProxyEnv();
    for (const key of ALL_PROXY_KEYS) expect(env[key]).toBe(proxyState.url);
    expect(env.NO_PROXY).toBe(NO_PROXY_HOSTS);
    expect(env.no_proxy).toBe(NO_PROXY_HOSTS);
    expect(Object.keys(env)).toHaveLength(7);
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

  it("survives buildSanitizedEnv's scrubbers via the extra overlay", async () => {
    const env = buildSanitizedEnv(await shellProxyEnv());
    expect(env.HTTP_PROXY).toBe(proxyState.url);
    expect(env.https_proxy).toBe(proxyState.url);
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

  it("guarded after the proxy has warmed → cached proxy env", async () => {
    await shellProxyEnv(); // warm the cache
    const env = shellProxyEnvSync();
    expect(env.HTTP_PROXY).toBe(proxyState.url);
    expect(env.no_proxy).toBe(NO_PROXY_HOSTS);
  });

  it("cold miss → {} for that spawn, then warms the proxy in the background", async () => {
    // Fresh module instance so the cache is genuinely cold (mocks persist).
    vi.resetModules();
    const fresh = await import("./shell-proxy-env.js");
    expect(fresh.shellProxyEnvSync()).toEqual({});
    // Let the background warm settle (mock resolves in microtasks).
    await new Promise((r) => setImmediate(r));
    expect(fresh.shellProxyEnvSync().HTTP_PROXY).toBe(proxyState.url);
  });
});
