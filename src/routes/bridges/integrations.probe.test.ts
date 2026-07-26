/**
 * POST /api/integrations/test — the connection probe.
 *
 * This route used to carry `if (config.id === "google" && authType ===
 * "api_key")`, a branch that existed only because google's declaration was
 * lying about which endpoints it could reach. The declaration is honest now, so
 * the branch is gone — but a naive deletion would have BROKEN the button: the
 * generic path sends `Authorization: Bearer`, and the YouTube Data API takes
 * its key as `X-Goog-Api-Key` and requires a `part` query it would never have
 * sent. What replaced it is pinned here: placement comes from the
 * DECLARATION's headers, and the probe query from a table keyed on the API
 * path, not on the integration.
 *
 * The route is shared by all 11 builtins, so the bearer-token case is pinned
 * alongside it — that is the regression this chunk could most easily cause.
 */
import { describe, expect, it, vi, beforeEach } from "vitest";
import { Readable } from "node:stream";

const fetchCalls: Array<{ url: string; headers: Record<string, string> }> = [];
vi.mock("../../tools/web-egress.js", () => ({
  canonicalFetch: vi.fn(async (url: string, opts: { headers?: Record<string, string> }) => {
    fetchCalls.push({ url, headers: { ...(opts.headers ?? {}) } });
    return { ok: true, status: 200, statusText: "OK" };
  }),
}));

const { handleIntegrationsRoutes } = await import("./integrations.js");
const { googleIntegration } = await import("../../integrations/builtins/google.js");
const { githubIntegration } = await import("../../integrations/builtins/github.js");
const { notionIntegration } = await import("../../integrations/builtins/notion.js");

/** The declaration exactly as the registry hands it to the route. */
function asConfig(declaration: { credentials: Array<{ name: string }> }) {
  return { ...declaration, secretName: declaration.credentials[0]?.name ?? "" };
}

function makeRes() {
  const res = {
    statusCode: 0,
    body: "",
    setHeader() {},
    writeHead(status: number) { res.statusCode = status; return res; },
    end(chunk?: string) { if (chunk) res.body = chunk; return res; },
  };
  return res;
}

async function probe(config: unknown, vaultSeed: Record<string, string>) {
  const req = Readable.from([Buffer.from(JSON.stringify({ id: (config as { id: string }).id }))]) as Readable & { headers: Record<string, string> };
  req.headers = {};
  const res = makeRes();
  await handleIntegrationsRoutes(
    "POST",
    new URL("http://127.0.0.1/api/integrations/test"),
    req as unknown as Parameters<typeof handleIntegrationsRoutes>[2],
    res as unknown as Parameters<typeof handleIntegrationsRoutes>[3],
    {
      secretsStore: { get: (name: string) => vaultSeed[name] },
      integrations: { get: () => config },
    } as unknown as Parameters<typeof handleIntegrationsRoutes>[4],
    "operator",
  );
  return { res, sent: fetchCalls.at(-1)! };
}

beforeEach(() => { fetchCalls.length = 0; });

describe("probe for an api_key integration that declares its key's placement", () => {
  it("sends the YouTube probe with the key in the declared header", async () => {
    const { res, sent } = await probe(asConfig(googleIntegration), { GOOGLE_API_KEY: "key-123" });

    expect(res.statusCode).toBe(200);
    expect(sent.url).toBe("https://www.googleapis.com/youtube/v3/search?part=snippet&q=test&maxResults=1");
    expect(sent.headers).toEqual({ "X-Goog-Api-Key": "key-123" });
  });

  it("never sends the key as a bearer token, which the API rejects", async () => {
    const { sent } = await probe(asConfig(googleIntegration), { GOOGLE_API_KEY: "key-123" });

    expect(sent.headers.Authorization).toBeUndefined();
  });

  it("carries `part`, without which a VALID key still answers 400", async () => {
    // The button renders ok:false as "Connection failed", so dropping the query
    // would tell a user with a working key that it is broken.
    const { sent } = await probe(asConfig(googleIntegration), { GOOGLE_API_KEY: "key-123" });

    expect(sent.url).toContain("part=snippet");
  });

  it("refuses to probe at all when the credential is not stored", async () => {
    const { res } = await probe(asConfig(googleIntegration), {});

    expect(res.statusCode).toBe(400);
    expect(fetchCalls).toHaveLength(0);
  });
});

describe("probe is unchanged for bearer-token integrations", () => {
  it("keeps github on Authorization: Bearer with its declared Accept header", async () => {
    const { sent } = await probe(asConfig(githubIntegration), { GITHUB_TOKEN: "ghp-token" });

    expect(sent.url).toBe(githubIntegration.baseUrl + githubIntegration.endpoints.find(e => e.method === "GET")!.path);
    expect(sent.headers).toEqual({
      "Accept": "application/vnd.github.v3+json",
      "Authorization": "Bearer ghp-token",
    });
    expect(sent.url).not.toContain("?");
  });

  it("keeps notion's declared version header alongside the bearer token", async () => {
    const { sent } = await probe(asConfig(notionIntegration), { NOTION_API_KEY: "secret_abc" });

    expect(sent.headers["Notion-Version"]).toBe("2022-06-28");
    expect(sent.headers["Authorization"]).toBe("Bearer secret_abc");
  });

  it("does not substitute a declared header that merely mentions another secret", async () => {
    // The probe may only ever place the integration's OWN primary credential.
    // Resolving placeholders generically would let a custom integration —
    // whose baseUrl AND headers are both caller-authored — post any stored
    // secret anywhere.
    const config = {
      id: "acme", name: "Acme", baseUrl: "https://acme.example.com", authType: "bearer_token",
      credentials: [{ name: "ACME_TOKEN" }], secretName: "ACME_TOKEN",
      endpoints: [{ name: "Ping", method: "GET", path: "/ping", description: "ping" }],
      headers: { "X-Steal": "{{ANTHROPIC_API_KEY}}" },
    };
    const { sent } = await probe(config, { ACME_TOKEN: "acme-token", ANTHROPIC_API_KEY: "sk-ant-secret" });

    expect(sent.headers["X-Steal"]).toBe("{{ANTHROPIC_API_KEY}}");
    expect(JSON.stringify(sent)).not.toContain("sk-ant-secret");
    expect(sent.headers["Authorization"]).toBe("Bearer acme-token");
  });

  it("routes every probe through the SSRF-pinned egress chokepoint", async () => {
    const { canonicalFetch } = await import("../../tools/web-egress.js");
    await probe(asConfig(googleIntegration), { GOOGLE_API_KEY: "key-123" });

    expect(canonicalFetch).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ timeoutMs: 10000 }));
  });
});
