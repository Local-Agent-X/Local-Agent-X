import { describe, it, expect, beforeAll, afterAll } from "vitest";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequestHandler } from "./request-handler.js";
import { deriveConnectorCapability } from "./app-connector-auth.js";
import { RBACManager } from "../rbac.js";
import { SecurityLayer } from "../security/index.js";
import { writeRunTargetManifest } from "../tools/app-run-target.js";
import type { LAXConfig } from "../types.js";

// ── F1 behavioral proof ─────────────────────────────────────────────────
// These tests stand up the REAL request handler over a loopback HTTP socket
// and drive it with real fetch(). They prove the auth-gate fix end-to-end:
//   - the deleted User-Agent exemption (spoofed UA no longer bypasses auth)
//   - the deleted kraken/fastmail prefix exemptions
//   - the least-privilege `agent` token is denied sensitive sinks
//   - a valid operator token still reaches the legitimate route
//   - the genuine auth-exempt set (/api/health) is preserved
//
// The auth gate (request-handler.ts ~73-92) runs BEFORE any route dispatch,
// so the 401/403 cases never touch route ctx — only the operator-200 case
// reaches the secrets route and exercises secretsStore.get().

const OP_TOKEN = "OP_TOKEN_" + "a1b2c3d4e5f60718293a4b5c6d7e8f90"; // 32 hex
const SEEDED_NAME = "SEEDED";
const SEEDED_VALUE = "s3cr3t-value";

let server: http.Server;
let port: number;
let tmpDir: string;
let rbac: RBACManager;

// One typed builder confines every cast. Real instances for the
// security-critical pieces (config, rbac, security, secretsStore); minimal
// inert stubs for everything else — the auth gate never reads them, and the
// route handlers guard on method/pathname before touching ctx fields.
function makeDeps() {
  const config = {
    port: 7099,
    authToken: OP_TOKEN,
    workspace: join(tmpDir, "workspace"),
    maxUploadBytes: 104857600,
  } as unknown as LAXConfig; // partial — handler only reads port/authToken here

  const secretsStore = {
    // Only `get` is exercised by the reveal route. Returns the seeded value
    // for the known name, undefined otherwise (→ 404).
    get: (name: string) => (name === SEEDED_NAME ? SEEDED_VALUE : undefined),
    list: () => [],
    listQuarantined: () => [],
  };

  const noop = () => {};
  // Inert stubs: shape-only, never invoked by the auth gate or by the
  // secrets-reveal route. `as unknown as T` is confined to this builder.
  const deps = {
    config,
    security: new SecurityLayer(join(tmpDir, "workspace"), "common"),
    toolPolicy: {} as unknown as never,
    rbac,
    dataDir: tmpDir,
    publicDir: join(tmpDir, "public"),
    sessionStore: {} as unknown as never,
    memoryIndex: {} as unknown as never,
    memoryManager: {} as unknown as never,
    secretsStore: secretsStore as unknown as never,
    cronService: {} as unknown as never,
    integrations: {} as unknown as never,
    whatsappBridge: {} as unknown as never,
    telegramBridge: {} as unknown as never,
    agentSync: {} as unknown as never,
    // `get` returns undefined for an unregistered app id — the production
    // AppRegistry behavior that makes handleAppRoutes fall through to the
    // static-file / dist serving path for a workspace-only (static-build) app.
    appRegistry: { get: () => undefined } as unknown as never,
    agentRunStore: {} as unknown as never,
    agentTemplateStore: {} as unknown as never,
    issueStore: {} as unknown as never,
    projectStore: {} as unknown as never,
    allAgentTools: [],
    toolRegistry: {} as unknown as never,
    bridgeTools: [],
    getOrCreateSession: (() => ({})) as unknown as never,
    saveSession: (async () => {}) as unknown as never,
    flushSession: (async () => {}) as unknown as never,
    getChatWs: (() => undefined) as unknown as never,
    broadcastAll: noop,
    activeOnEventBySession: new Map(),
    activeBrowserSessionIdRef: { value: "" },
    activeRuntimeBySession: new Map(),
  };
  return deps as unknown as Parameters<typeof createRequestHandler>[0];
}

const REPORT_JOB_ID = "cron_testjob";

beforeAll(async () => {
  tmpDir = mkdtempSync(join(tmpdir(), "request-handler-test-"));
  mkdirSync(join(tmpDir, "public"), { recursive: true });
  writeFileSync(join(tmpDir, "public", "app.html"), "<!doctype html><html><head><title>core</title></head><body>shell</body></html>");
  mkdirSync(join(tmpDir, "public", "js"), { recursive: true });
  mkdirSync(join(tmpDir, "public", "css"), { recursive: true });
  mkdirSync(join(tmpDir, "public", "vendor"), { recursive: true });
  writeFileSync(join(tmpDir, "public", "bundle.html"), [
    '<!doctype html><html><head>',
    '<script src="/js/one.js"></script>',
    '<link rel="stylesheet" href="/css/site.css?v=v1">',
    '<script src="/vendor/lib.js"></script>',
    '<script type="module" src="/js/mod.js?v=v2"></script>',
    "</head><body>bundle</body></html>",
  ].join(""));
  writeFileSync(join(tmpDir, "public", "js", "one.js"), "window.bundleContract = true;");
  writeFileSync(join(tmpDir, "public", "css", "site.css"), "body{color:#000}");
  writeFileSync(join(tmpDir, "public", "vendor", "lib.js"), "window.vendorContract = true;");
  writeFileSync(join(tmpDir, "public", "js", "mod.js"), "export {};");
  mkdirSync(join(tmpDir, "workspace", "videos"), { recursive: true });
  writeFileSync(join(tmpDir, "workspace", "videos", "sample.mp4"), "0123456789");
  // Seed a cron report so /api/cron/<id>/reports/latest renders 200 HTML.
  // dataDir === tmpDir, and the route reads <dataDir>/cron/reports/<id>/*.md.
  const reportDir = join(tmpDir, "cron", "reports", REPORT_JOB_ID);
  mkdirSync(reportDir, { recursive: true });
  writeFileSync(join(reportDir, "report.md"), "# Mission report\n\nbody.");
  // Real RBAC: gives the operator token (= config.authToken) and the
  // per-process internal `agent` token via getInternalAgentToken().
  rbac = new RBACManager(tmpDir, OP_TOKEN);
  server = http.createServer(createRequestHandler(makeDeps()));
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  port = (server.address() as AddressInfo).port;
});

afterAll(async () => {
  await new Promise<void>((r) => server.close(() => r()));
  rmSync(tmpDir, { recursive: true, force: true });
});

const base = () => `http://127.0.0.1:${port}`;

describe("F1: auth gate over a real HTTP round-trip", () => {
  it("spoofed User-Agent with NO token cannot reveal a secret (deleted UA exemption — critical regression guard)", async () => {
    const res = await fetch(`${base()}/api/secrets/X/reveal`, {
      headers: { "User-Agent": "LocalAgentX/0.1" },
    });
    expect(res.status).toBe(401);
  });

  it("spoofed User-Agent 'SecretAgentX' with NO token is still 401", async () => {
    const res = await fetch(`${base()}/api/secrets/X/reveal`, {
      headers: { "User-Agent": "SecretAgentX" },
    });
    expect(res.status).toBe(401);
  });

  it("NO token on the connector proxy is 401 (no proxy prefix exemptions)", async () => {
    // POST is allowed for same-origin loopback (no Origin header → no CSRF
    // block), so the auth gate is what produces the 401 here.
    const res = await fetch(`${base()}/api/connectors/fastmail/jmap/api`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    });
    expect(res.status).toBe(401);
  });

  it("NO token on the connector listing is 401 (prefix exemption removed)", async () => {
    const res = await fetch(`${base()}/api/connectors`);
    expect(res.status).toBe(401);
  });

  it("least-privilege agent token is denied the sensitive secrets sink (403)", async () => {
    const res = await fetch(`${base()}/api/secrets/X/reveal`, {
      headers: { Authorization: `Bearer ${rbac.getInternalAgentToken()}` },
    });
    expect(res.status).toBe(403);
  });

  it("operator token reaches the reveal route and returns the seeded value (200) — fix did not over-block the UI path", async () => {
    const res = await fetch(`${base()}/api/secrets/${SEEDED_NAME}/reveal`, {
      headers: { Authorization: `Bearer ${OP_TOKEN}` },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { name: string; value: string };
    expect(body.value).toBe(SEEDED_VALUE);
  });

  it("auth-exempt /api/health stays open without a token (exempt set preserved)", async () => {
    const res = await fetch(`${base()}/api/health`);
    expect(res.status).not.toBe(401);
  });

  // ── SC-5: only bare /api/health is exempt — subroutes stay gated ──────────
  // The old `/api/health/` PREFIX exemption leaked provider status and queue
  // depth / active-op counts to any token-less local process. The exemption is
  // now an exact-match Set, so the subtree requires auth like any other read.
  it("/api/health/providers requires a token (SC-5: no /api/health/ prefix exemption)", async () => {
    const res = await fetch(`${base()}/api/health/providers`);
    expect(res.status).toBe(401);
  });

  it("/api/health/workers requires a token (SC-5: queue depth / active-op counts are not public)", async () => {
    const res = await fetch(`${base()}/api/health/workers`);
    expect(res.status).toBe(401);
  });

  // ── Browser-openable report HTML route: ?token= auth ────────────────────
  // Regression for the worker-card "Open report" link returning
  // {"error":"Unauthorized"}. A top-level browser navigation can't send an
  // Authorization header, so this GET route accepts ?token=. The next two
  // tests fence that exception so it never widens to other routes.

  it("report-latest with ?token= (no Authorization header) renders the report — the Open-link fix", async () => {
    const res = await fetch(`${base()}/api/cron/${REPORT_JOB_ID}/reports/latest?token=${OP_TOKEN}`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
    expect(await res.text()).toContain("Mission report");
  });

  it("report-latest with NO token is still 401 (the route is not public)", async () => {
    const res = await fetch(`${base()}/api/cron/${REPORT_JOB_ID}/reports/latest`);
    expect(res.status).toBe(401);
  });

  it("?token= is NOT honored on a non-allowlisted /api GET route (no security regression)", async () => {
    // Same valid operator token in the query string, but on the secrets-reveal
    // route. The gate must ignore it there → 401, proving the query-token
    // exception is confined to the browser-openable allowlist.
    const res = await fetch(`${base()}/api/secrets/${SEEDED_NAME}/reveal?token=${OP_TOKEN}`);
    expect(res.status).toBe(401);
  });
});

// ── C7 round-2: the egress-granting /api/local-runtimes route is agent-fenced ──
// The C7 fold made every settings.localRuntimes entry widen the agent's OWN
// egress (each entry = an exact host:port evaluateWebFetch then allows). That
// turns the WRITE route into a privilege boundary: an injected agent's self-call
// auto-carries the internal agent token (tools/web-egress.ts selfCallAuthHeader),
// so unless the route is fenced the agent could POST an arbitrary LAN host into
// its own egress allowlist and then reach it — a confused-deputy escalation.
// These drive the REAL authorizeRequest gate over a live socket (the earlier
// route test called the handler with a hand-picked "owner" role, bypassing it)
// and prove the attack entry never comes into existence.
describe("C7: agent role is fenced out of the egress-granting /api/local-runtimes route", () => {
  const AGENT = () => rbac.getInternalAgentToken();
  const ATTACK = "http://192.168.66.66:11434"; // a LAN host the operator never named

  it("agent self-call POST is denied AT checkEndpoint (403 with the RBAC reason, not a CSRF/401)", async () => {
    const res = await fetch(`${base()}/api/local-runtimes`, {
      method: "POST",
      headers: { Authorization: `Bearer ${AGENT()}`, "Content-Type": "application/json" },
      body: JSON.stringify({ kind: "ollama", baseUrl: ATTACK }),
    });
    expect(res.status).toBe(403);
    // Pin the denial to the RBAC endpoint gate: the reason string is
    // checkEndpoint's ("...cannot access..."), distinguishing it from the CSRF
    // 403 ("Cross-origin mutation blocked") so this can't pass for the wrong reason.
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain("cannot access");
  });

  it("agent self-call DELETE is denied too (both mutating methods fenced)", async () => {
    const res = await fetch(`${base()}/api/local-runtimes?baseUrl=${encodeURIComponent(ATTACK)}`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${AGENT()}` },
    });
    expect(res.status).toBe(403);
  });

  it("operator token clears the gate and reaches the handler (settings UI path unaffected)", async () => {
    // Empty body → the route's own 400 (Invalid JSON). The contract under test
    // is that it is NEITHER 401 NOR 403: operator passed the RBAC boundary and
    // reached the handler, so the fence didn't over-block the legitimate path.
    const res = await fetch(`${base()}/api/local-runtimes`, {
      method: "POST",
      headers: { Authorization: `Bearer ${OP_TOKEN}` },
    });
    expect(res.status).not.toBe(401);
    expect(res.status).not.toBe(403);
    expect(res.status).toBe(400);
  });

  it("attack chain dies at the gate: an agent-POST'd entry never comes into existence", async () => {
    // The refutation in one assertion: after the agent's denied self-call, no
    // settings.localRuntimes entry for the attack host exists — so the C7 egress
    // carve-out never opens for it. Read the truth through the operator GET,
    // which returns manualRuntimeEntries() (the same set the carve-out derives).
    const attempt = await fetch(`${base()}/api/local-runtimes`, {
      method: "POST",
      headers: { Authorization: `Bearer ${AGENT()}`, "Content-Type": "application/json" },
      body: JSON.stringify({ kind: "ollama", baseUrl: ATTACK }),
    });
    expect(attempt.status).toBe(403); // never reached the persisting handler

    const view = await fetch(`${base()}/api/local-runtimes`, {
      headers: { Authorization: `Bearer ${OP_TOKEN}` },
    });
    expect(view.status).toBe(200);
    const body = (await view.json()) as { manual: Array<{ baseUrl: string }> };
    expect(body.manual.some((m) => m.baseUrl.includes("192.168.66.66"))).toBe(false);
  });
});

// ── Static-build app serving ────────────────────────────────────────────────
// A finished frontend-spa build serves its built dist/ directly at /apps/<id>/
// with NO dev server (app-run-target marker). These prove the request handler
// rebases the URL under dist/, serves the built assets, and history-falls-back
// deep links to index.html — the behavior that lets a client-only app open in a
// plain browser tab / offline.
describe("static-build app serving (/apps/<id>/ → dist/)", () => {
  const APP = "spa-app";
  beforeAll(() => {
    const appDir = join(tmpDir, "workspace", "apps", APP);
    mkdirSync(join(appDir, "dist", "assets"), { recursive: true });
    writeFileSync(join(appDir, "dist", "index.html"), "<!doctype html><html><head><title>built</title></head><body><div id=root></div><script type=module src=\"/apps/spa-app/assets/app.js\"></script></body></html>");
    writeFileSync(join(appDir, "dist", "assets", "app.js"), "console.log('built spa');");
    writeRunTargetManifest(appDir, { mode: "static-build", distDir: "dist", framework: "vite" });
  });

  it("serves the built index.html at /apps/<id>/ with the connector bootstrap injected", async () => {
    const res = await fetch(`${base()}/apps/${APP}/`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
    const html = await res.text();
    expect(html).toContain("<title>built</title>");
    expect(html).toContain("__LAX_CONNECTOR_TOKEN__");   // operator token stripped, connector cap injected
  });

  it("serves a built asset under dist/ with the right content-type", async () => {
    const res = await fetch(`${base()}/apps/${APP}/assets/app.js`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("application/javascript");
    expect(await res.text()).toContain("built spa");
  });

  it("deep-links (client routes) history-fall-back to index.html", async () => {
    const res = await fetch(`${base()}/apps/${APP}/dashboard/settings`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
    expect(await res.text()).toContain("<title>built</title>");
  });

  it("a missing ASSET (has a file extension) 404s — it must NOT fall back to index.html", async () => {
    const res = await fetch(`${base()}/apps/${APP}/assets/missing.js`);
    expect(res.status).toBe(404);
  });
});

interface ContractOutcome {
  status: number;
  contentType: string;
  cacheControl: string;
  body: string;
}

async function outcome(path: string, init?: RequestInit): Promise<ContractOutcome> {
  const response = await fetch(`${base()}${path}`, init);
  return {
    status: response.status,
    contentType: response.headers.get("content-type") || "",
    cacheControl: response.headers.get("cache-control") || "",
    body: await response.text(),
  };
}

describe("request-handler extraction preserves the recorded legacy contract", () => {
  it("matches representative API, static, media, app fallback, and traversal outcomes", async () => {
    const auth = { Authorization: `Bearer ${OP_TOKEN}` };
    const actual = {
      unauthenticatedApi: await outcome(`/api/secrets/${SEEDED_NAME}/reveal`),
      authenticatedApi: await outcome(`/api/secrets/${SEEDED_NAME}/reveal`, { headers: auth }),
      coreStatic: await outcome("/app.html"),
      mediaWithRange: await outcome(`/videos/sample.mp4?token=${OP_TOKEN}`, { headers: { Range: "bytes=2-5" } }),
      appDeepLink: await outcome("/apps/spa-app/dashboard/settings"),
      appTraversal: await outcome(`/apps/spa-app/%2e%2e%2fsecret.txt`),
      protectedTraversal: await outcome(`/files/%2e%2e%2fsecret.txt?token=${OP_TOKEN}`),
    };

    expect(actual).toEqual({
      unauthenticatedApi: { status: 401, contentType: "application/json", cacheControl: "", body: '{"error":"Unauthorized"}' },
      authenticatedApi: { status: 200, contentType: "application/json", cacheControl: "", body: `{"name":"${SEEDED_NAME}","value":"${SEEDED_VALUE}"}` },
      coreStatic: { status: 200, contentType: "text/html", cacheControl: "no-cache, must-revalidate", body: "<!doctype html><html><head><title>core</title></head><body>shell</body></html>" },
      mediaWithRange: { status: 200, contentType: "video/mp4", cacheControl: "", body: "0123456789" },
      appDeepLink: expect.objectContaining({ status: 200, contentType: "text/html", cacheControl: "no-cache, must-revalidate" }),
      appTraversal: { status: 404, contentType: "application/json", cacheControl: "", body: '{"error":"Not found"}' },
      protectedTraversal: { status: 403, contentType: "application/json", cacheControl: "", body: '{"error":"Path traversal blocked"}' },
    });
    expect(actual.appDeepLink.body).toContain("<title>built</title>");
    expect(actual.appDeepLink.body).toContain("__LAX_CONNECTOR_TOKEN__");
  });

  it("keeps query-token authentication confined to the browser report allowlist", async () => {
    const actual = {
      report: await outcome(`/api/cron/${REPORT_JOB_ID}/reports/latest?token=${OP_TOKEN}`),
      ordinaryApi: await outcome(`/api/secrets/${SEEDED_NAME}/reveal?token=${OP_TOKEN}`),
    };
    expect(actual.report.status).toBe(200);
    expect(actual.report.contentType).toContain("text/html");
    expect(actual.ordinaryApi).toEqual({ status: 401, contentType: "application/json", cacheControl: "", body: '{"error":"Unauthorized"}' });
  });

  it("preserves connector capability scope through the request auth gate", async () => {
    const capability = deriveConnectorCapability(OP_TOKEN);
    const connector = await outcome("/api/connectors/INVALID", { headers: { Authorization: `Bearer ${capability}` } });
    const nonConnector = await outcome(`/api/secrets/${SEEDED_NAME}/reveal`, { headers: { Authorization: `Bearer ${capability}` } });
    expect(connector).toEqual({ status: 400, contentType: "application/json", cacheControl: "", body: '{"error":"Connector name must be a lowercase slug."}' });
    expect(nonConnector).toEqual({ status: 401, contentType: "application/json", cacheControl: "", body: '{"error":"Unauthorized"}' });
  });

  it("preserves exact HTML security headers and immutable static bundle caching", async () => {
    const core = await fetch(`${base()}/app.html`);
    expect(Object.fromEntries([
      "content-security-policy", "x-content-type-options", "x-frame-options",
      "referrer-policy", "permissions-policy", "cache-control", "pragma",
    ].map(name => [name, core.headers.get(name)]))).toEqual({
      "content-security-policy": "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self' http://127.0.0.1:* http://localhost:* ws://127.0.0.1:* ws://localhost:*; media-src 'self' blob: mediastream:; frame-src 'self' http://127.0.0.1:* http://localhost:*; frame-ancestors 'self'; object-src 'none'; base-uri 'self'; form-action 'self'",
      "x-content-type-options": "nosniff",
      "x-frame-options": "SAMEORIGIN",
      "referrer-policy": "no-referrer",
      "permissions-policy": "camera=(self), microphone=(self), geolocation=()",
      "cache-control": "no-cache, must-revalidate",
      pragma: "no-cache",
    });

    const page = await fetch(`${base()}/bundle.html`);
    const html = await page.text();
    const bundlePath = html.match(/src="(\/js\/_bundle\/[^"?]+)\?v=\d+"/)?.[1];
    expect(bundlePath).toBe("/js/_bundle/bundle.js");
    const bundle = await fetch(`${base()}${bundlePath}`);
    expect(bundle.status).toBe(200);
    expect(bundle.headers.get("cache-control")).toBe("public, max-age=31536000, immutable");
    expect(bundle.headers.get("x-content-type-options")).toBe("nosniff");
    expect(await bundle.text()).toContain("window.bundleContract = true;");
  });

  // Regression (boot lag): assets used to ship with no Cache-Control and no
  // validators, so every Electron boot re-downloaded the whole UI. HTML now
  // stamps css/vendor/module-js tags with ?v=<mtime> (served immutable) and
  // unstamped assets revalidate via ETag → 304.
  it("stamps asset tags in HTML and serves stamped-immutable / unstamped-304 assets", async () => {
    const html = await (await fetch(`${base()}/bundle.html`)).text();
    const cssSrc = html.match(/href="(\/css\/site\.css\?v=\d+)"/)?.[1];
    const vendorSrc = html.match(/src="(\/vendor\/lib\.js\?v=\d+)"/)?.[1];
    const modSrc = html.match(/src="(\/js\/mod\.js\?v=\d+)"/)?.[1];
    expect(cssSrc && vendorSrc && modSrc).toBeTruthy(); // hand ?v= replaced by mtime stamps
    for (const src of [cssSrc, vendorSrc, modSrc]) {
      const res = await fetch(`${base()}${src}`);
      expect(res.status).toBe(200);
      expect(res.headers.get("cache-control")).toBe("public, max-age=31536000, immutable");
      expect(res.headers.get("etag")).toBeTruthy();
    }
    // Unstamped URL (a CSS url() ref can't carry a stamp): cached + revalidated.
    const first = await fetch(`${base()}/css/site.css`);
    expect(first.status).toBe(200);
    expect(first.headers.get("cache-control")).toBe("no-cache");
    const etag = first.headers.get("etag");
    expect(etag).toBeTruthy();
    const revalidated = await fetch(`${base()}/css/site.css`, { headers: { "If-None-Match": etag! } });
    expect(revalidated.status).toBe(304);
    expect(await revalidated.text()).toBe("");
  });
});
