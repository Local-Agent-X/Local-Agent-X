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

// The non-HTTP branch. `email` is not reachable by HTTP at all, so "test" for
// it means the SMTP handshake email_send already makes, over the config
// getSmtpConfig() reads — never a probe URL.
const smtp = vi.hoisted(() => ({
  config: undefined as unknown,
  verifyError: undefined as Error | undefined,
  transports: [] as Array<Record<string, unknown>>,
  verifyCount: 0,
}));
vi.mock("nodemailer", () => ({
  createTransport: (opts: Record<string, unknown>) => {
    smtp.transports.push(opts);
    return { verify: async () => { smtp.verifyCount++; if (smtp.verifyError) throw smtp.verifyError; return true; } };
  },
}));
// Only the two functions that would touch the network or the real ~/.lax are
// replaced. ownsEmailConfig() is deliberately the REAL one — it is the rule
// under test here, and a stubbed copy would pin the stub.
vi.mock("../../tools/email-config.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../tools/email-config.js")>()),
  getSmtpConfig: () => smtp.config,
  writeEmailCredentials: () => null,
}));

const { handleIntegrationsRoutes } = await import("./integrations.js");
const { googleIntegration } = await import("../../integrations/builtins/google.js");
const { githubIntegration } = await import("../../integrations/builtins/github.js");
const { notionIntegration } = await import("../../integrations/builtins/notion.js");
const { emailIntegration } = await import("../../integrations/builtins/email.js");

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

beforeEach(() => {
  fetchCalls.length = 0;
  smtp.transports.length = 0;
  smtp.verifyCount = 0;
  smtp.verifyError = undefined;
  smtp.config = { host: "smtp.example.com", port: 587, user: "me@example.com", pass: "app-password", from: "me@example.com" };
});

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

describe("probe for an integration whose transport is not HTTP", () => {
  const email = { ...emailIntegration, secretName: "SMTP_PASS" };

  it("never builds an HTTP probe URL for it", async () => {
    // The defect: `baseUrl` is "" and the endpoint path is the pseudo-path
    // "smtp", so the HTTP branch joined them into the URL "smtp" and fired a
    // request at it. Email is not reachable by HTTP at all.
    await probe(email, { SMTP_PASS: "app-password" });

    expect(fetchCalls).toHaveLength(0);
  });

  it("verifies the real mailbox rather than claiming a connection it did not make", async () => {
    const { res } = await probe(email, {});

    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toMatchObject({ ok: true, transport: "smtp_imap" });
    expect(smtp.verifyCount).toBe(1);
    expect(smtp.transports[0]).toMatchObject({
      host: "smtp.example.com",
      port: 587,
      auth: { user: "me@example.com", pass: "app-password" },
    });
  });

  it("reports an incomplete configuration WITHOUT dialling anything", async () => {
    smtp.config = "Email not configured. Go to Settings → Connected APIs → Email (SMTP/IMAP) to set up, or set env vars: SMTP_HOST";

    const { res } = await probe(email, { SMTP_PASS: "app-password" });

    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ ok: false, transport: "smtp_imap", error: smtp.config });
    expect(smtp.transports).toHaveLength(0);
    expect(smtp.verifyCount).toBe(0);
  });

  it("reports a rejected handshake as a failure, naming the host it dialled", async () => {
    smtp.verifyError = new Error("535 5.7.8 Username and Password not accepted");

    const { res } = await probe(email, {});
    const body = JSON.parse(res.body);

    expect(body.ok).toBe(false);
    expect(body.error).toContain("smtp.example.com:587");
    expect(body.error).toContain("535");
  });

  it("does not gate the test on a vault entry the password need not live under", async () => {
    // email-config's SMTP_PASS_SECRET indirection lets the password live under
    // any vault name, so refusing to probe unless `secretName` is present would
    // report "No credentials found" for a mailbox that works.
    const { res } = await probe(email, {});

    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).ok).toBe(true);
  });

  it("dials the host from the email config, never one the declaration names", async () => {
    // The declaration is authored over the network (POST /api/integrations
    // accepts any body), so it must not get to choose where the password goes.
    await probe({ ...email, baseUrl: "https://attacker.example.com" }, {});

    expect(smtp.transports[0].host).toBe("smtp.example.com");
    expect(fetchCalls).toHaveLength(0);
  });

  it("refuses to run the mailbox test for an integration that does not own it", async () => {
    // Same rule as the install sink, applied to the read side: `transport` is
    // caller-authored, so without ownership any installed integration could
    // trigger a handshake against the user's mailbox and read back the account
    // and host it authenticated as.
    const impostor = { ...email, id: "totally-unrelated-widget", builtin: false };

    const { res } = await probe(impostor, {});

    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).error).toMatch(/does not own the email configuration/);
    expect(smtp.transports).toHaveLength(0);
    expect(smtp.verifyCount).toBe(0);
    expect(fetchCalls).toHaveLength(0);
  });
});

describe("probe places the credential where the declaration says, not where the vault names it", () => {
  it("substitutes into the declared header for a RENAMED primary", async () => {
    // A saved integrations.json may point google's primary at any vault entry;
    // the registry renames the credential but NOT the shipped headers map, which
    // still says {{GOOGLE_API_KEY}}. Matching only the renamed name sent the
    // literal placeholder AND a bearer token YouTube rejects — "Connection
    // failed" for a perfectly good key.
    const renamed = { ...googleIntegration, credentials: [{ name: "MY_YT_KEY" }], secretName: "MY_YT_KEY" };

    const { sent } = await probe(renamed, { MY_YT_KEY: "key-123" });

    expect(sent.headers["X-Goog-Api-Key"]).toBe("key-123");
    expect(sent.headers.Authorization).toBeUndefined();
    expect(JSON.stringify(sent)).not.toContain("{{");
  });

  it("substitutes a placeholder EMBEDDED in a declared header value", async () => {
    // Overwriting the whole header value would drop the scheme prefix the API
    // requires, sending a bare token where "Key <token> v2" was declared.
    const config = {
      id: "acme", name: "Acme", baseUrl: "https://acme.example.com", authType: "api_key",
      credentials: [{ name: "ACME_TOKEN" }], secretName: "ACME_TOKEN",
      endpoints: [{ name: "Ping", method: "GET", path: "/ping", description: "ping" }],
      headers: { "X-Acme-Auth": "Key {{ACME_TOKEN}} v2" },
    };

    const { sent } = await probe(config, { ACME_TOKEN: "acme-token" });

    expect(sent.headers["X-Acme-Auth"]).toBe("Key acme-token v2");
    expect(sent.headers.Authorization).toBeUndefined();
  });

  it("leaves declared headers untouched when the integration names no credential", async () => {
    // An empty credential name must not become a placeholder that matches
    // everything: a bare "" is contained in every string, which would splice the
    // token between every character of every declared header.
    const config = {
      id: "bare", name: "Bare", baseUrl: "https://bare.example.com", authType: "bearer_token",
      credentials: [] as Array<{ name: string }>, secretName: "",
      endpoints: [{ name: "Ping", method: "GET", path: "/ping", description: "ping" }],
      headers: { "X-Static": "constant" },
    };

    const { sent } = await probe(config, { "": "tok" });

    expect(sent.headers["X-Static"]).toBe("constant");
    expect(sent.headers.Authorization).toBe("Bearer tok");
  });
});
