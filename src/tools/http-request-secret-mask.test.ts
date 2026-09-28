// http_request masks secret values BEFORE its `find` filter runs, so the model
// cannot grep a value out of a response it may not see. Drives the real tool
// against a scripted undici fetch (the same mock shape web-tools.test.ts uses).

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

const undiciMock = vi.hoisted(() => ({
  handler: null as null | ((url: string, opts: unknown) => unknown),
}));
vi.mock("undici", async (importActual) => {
  const actual = await importActual<typeof import("undici")>();
  return {
    ...actual,
    fetch: (url: unknown, opts?: unknown) =>
      undiciMock.handler ? undiciMock.handler(String(url), opts) : actual.fetch(url as never, opts as never),
  };
});

const { createHttpRequestTool } = await import("./http-request.js");
const { unregisterRedactedSecretValue, scanForSecrets } = await import("../security/secrets/index.js");

function fakeResponse(status: number, body: string, contentType = "application/json") {
  const h = new Map([["content-type", contentType]]);
  return {
    status,
    statusText: status === 200 ? "OK" : "",
    ok: status >= 200 && status < 300,
    headers: {
      get: (k: string) => h.get(k.toLowerCase()) ?? null,
      forEach: (cb: (v: string, k: string) => void) => h.forEach((v, k) => cb(v, k)),
    },
    text: async () => body,
  };
}

const PASSWORD = "correct-horse-battery-staple-http-42";
const SERVICE_KEY = "sbp_" + "k9Lm".repeat(8);
const SECRETS = JSON.stringify([
  { name: "DB_PASSWORD", value: PASSWORD },
  { name: "SERVICE_KEY", value: SERVICE_KEY },
  { name: "REGION", value: "us-east-1" },
]);

describe("http_request — secret values are masked before `find`", () => {
  const tool = createHttpRequestTool();
  beforeEach(() => {
    undiciMock.handler = (url) => fakeResponse(200, url.includes("/secrets") ? SECRETS : '{"functions":["hello"]}');
  });
  afterEach(() => {
    undiciMock.handler = null;
    unregisterRedactedSecretValue(PASSWORD);
    unregisterRedactedSecretValue(SERVICE_KEY);
  });

  it("a find that selects a secret's row shows the name and a masked value", async () => {
    const res = await tool.execute({ url: "https://api.supabase.com/v1/projects/abc/secrets", find: "DB_PASSWORD" });
    expect(res.isError).toBeFalsy();
    expect(res.content).toContain("DB_PASSWORD");
    expect(res.content).not.toContain(PASSWORD);
    expect(res.content).toContain('"value": "corr****"');
    expect(res.content).toContain("secret values masked");
    // Every value the secrets endpoint returned is masked, the region included:
    // a secrets store's values are secrets by declaration, not by shape.
    expect(res.metadata?.secrets_masked).toBe(3);
    expect(res.metadata?.match_count).toBe(1);
  });

  it("a find for the value itself matches nothing — the filter runs on masked text", async () => {
    const res = await tool.execute({ url: "https://api.supabase.com/v1/projects/abc/secrets", find: PASSWORD });
    expect(res.content).not.toContain(PASSWORD);
    expect(res.metadata?.match_count).toBe(0);
  });

  it("the fetched values are registered as known secrets", async () => {
    await tool.execute({ url: "https://api.supabase.com/v1/projects/abc/secrets" });
    expect(scanForSecrets(`x=${PASSWORD}`).clean).toBe(false);
    expect(scanForSecrets(`x=${SERVICE_KEY}`).clean).toBe(false);
  });

  it("a response with no secrets carries no note and no masked count", async () => {
    const res = await tool.execute({ url: "https://api.supabase.com/v1/projects/abc/functions" });
    expect(res.content).toContain('"functions"');
    expect(res.content).not.toContain("masked");
    expect(res.metadata?.secrets_masked).toBeUndefined();
  });
});
