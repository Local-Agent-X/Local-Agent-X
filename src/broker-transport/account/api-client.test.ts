import { describe, it, expect } from "vitest";
import { AgentxosApiClient, ApiError, type FetchLike } from "./api-client.js";

interface Call {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: unknown;
}

/** A fake fetch that records the call and returns a canned JSON Response. */
function fakeFetch(status: number, payload: unknown): { fetch: FetchLike; calls: Call[] } {
  const calls: Call[] = [];
  const fetch: FetchLike = async (url, init) => {
    calls.push({
      url,
      method: init?.method ?? "GET",
      headers: (init?.headers as Record<string, string>) ?? {},
      body: init?.body ? JSON.parse(init.body as string) : undefined,
    });
    return new Response(JSON.stringify(payload), { status, headers: { "content-type": "application/json" } });
  };
  return { fetch, calls };
}

describe("AgentxosApiClient", () => {
  it("startDeviceCode POSTs to the start endpoint and returns the grant", async () => {
    const { fetch, calls } = fakeFetch(200, { deviceCode: "dc", userCode: "ABCD2345", userCodeDisplay: "ABCD-2345", verificationUri: "u", verificationUriComplete: "uc", expiresIn: 600, interval: 5 });
    const api = new AgentxosApiClient("https://app.agentxos.ai", fetch);
    const out = await api.startDeviceCode();
    expect(out.userCodeDisplay).toBe("ABCD-2345");
    expect(calls[0].url).toBe("https://app.agentxos.ai/api/device-code/start");
    expect(calls[0].method).toBe("POST");
  });

  it("registerDevice sends the Bearer token + body", async () => {
    const { fetch, calls } = fakeFetch(200, { ok: true, deviceId: "dev-1", created: true });
    const api = new AgentxosApiClient("https://app.agentxos.ai", fetch);
    const out = await api.registerDevice("tok-xyz", { kind: "desktop", publicKey: "PEM", label: "Mac" });
    expect(out).toEqual({ ok: true, deviceId: "dev-1", created: true });
    expect(calls[0].headers.authorization).toBe("Bearer tok-xyz");
    expect(calls[0].body).toEqual({ kind: "desktop", publicKey: "PEM", label: "Mac" });
  });

  it("listPairings GETs with the token and unwraps the array", async () => {
    const { fetch, calls } = fakeFetch(200, { ok: true, pairings: [{ pairingId: "p1", desktopDeviceId: "d1", phoneDeviceId: "ph1", desktopLabel: null, phoneLabel: null, createdAt: 1 }] });
    const api = new AgentxosApiClient("https://app.agentxos.ai", fetch);
    const out = await api.listPairings("tok");
    expect(out).toHaveLength(1);
    expect(out[0].phoneDeviceId).toBe("ph1");
    expect(calls[0].method).toBe("GET");
    expect(calls[0].headers.authorization).toBe("Bearer tok");
  });

  it("throws an ApiError carrying the route's code + message on a non-2xx", async () => {
    const { fetch } = fakeFetch(401, { ok: false, code: "unauthenticated", message: "Sign in to register a device." });
    const api = new AgentxosApiClient("https://app.agentxos.ai", fetch);
    await expect(api.registerDevice("bad", { kind: "desktop", publicKey: "x", label: "y" })).rejects.toMatchObject({
      status: 401,
      code: "unauthenticated",
      message: "Sign in to register a device.",
    });
  });

  it("maps a thrown fetch (network/DNS/TLS) to a retryable ApiError", async () => {
    const fetch: FetchLike = async () => {
      throw new Error("getaddrinfo ENOTFOUND");
    };
    const api = new AgentxosApiClient("https://app.agentxos.ai", fetch);
    const err = await api.startDeviceCode().catch((e) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).code).toBe("network_error");
  });

  it("normalizes a trailing slash on the base URL", async () => {
    const { fetch, calls } = fakeFetch(200, { deviceCode: "d", userCode: "u", userCodeDisplay: "u", verificationUri: "", verificationUriComplete: "", expiresIn: 1, interval: 1 });
    const api = new AgentxosApiClient("https://app.agentxos.ai/", fetch);
    await api.startDeviceCode();
    expect(calls[0].url).toBe("https://app.agentxos.ai/api/device-code/start");
  });
});
