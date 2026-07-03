import { describe, it, expect, beforeAll, afterAll } from "vitest";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequestHandler } from "./request-handler.js";
import { RBACManager } from "../rbac.js";
import { SecurityLayer } from "../security/index.js";
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
    appRegistry: {} as unknown as never,
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
