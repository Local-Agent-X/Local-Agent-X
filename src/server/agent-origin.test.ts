import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createServer, request, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { agentOrigin, routeUiAgentPaths, startAgentOrigin } from "./agent-origin.js";
import { deriveFilesLinkCapability, signAgentFilePath, verifyAgentFileSignature } from "./agent-file-links.js";
import { deriveAppDataCapability, deriveConnectorCapability } from "./app-connector-auth.js";
import type { ServerContext } from "../server-context.js";
import type { LAXConfig } from "../types.js";
import type { Role } from "../rbac.js";

// The agent origin is the boundary between what the agent wrote and the shell
// that holds the operator token and window.desktop. These tests stand up both
// listeners for real: the UI side (routeUiAgentPaths) must never render an
// agent path, and the agent side must never hand out or accept the operator
// token, and must keep apps working (connectors, IDE bridge) on its own terms.

const OP_TOKEN = "op-token-" + "0123456789abcdef0123456789abcdef";
const UI_PORT = 7123;
const publicDir = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "public");

let root: string;
let config: LAXConfig;
let agentServer: Server;
let uiServer: Server;
let uiBase: string;

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), "agent-origin-"));
  const workspace = join(root, "workspace");
  mkdirSync(join(workspace, "apps", "demo"), { recursive: true });
  writeFileSync(join(workspace, "apps", "demo", "index.html"), "<!doctype html><html><head><title>demo</title></head><body>app</body></html>");
  mkdirSync(join(workspace, "reports"), { recursive: true });
  writeFileSync(join(workspace, "reports", "q3.html"), "<!doctype html><p>report</p>");
  writeFileSync(join(workspace, "reports", "chart.svg"), "<svg xmlns='http://www.w3.org/2000/svg'><script>1</script></svg>");
  writeFileSync(join(workspace, "secret.txt"), "do not leak");
  config = { port: UI_PORT, authToken: OP_TOKEN, workspace } as LAXConfig;
  const board = { id: "board", name: "Board", description: "", status: "active", version: 1, layout: { type: "stack" }, components: [] };
  const appRegistry = {
    get: (id: string) => (id === "board" ? board : undefined),
    getState: (id: string) => (id === "board" ? { componentValues: { n: 1 }, actionQueue: [] } : null),
    pushEvent: (appId: string, event: object) => ({ event: { ...event, appId } }),
    consumeActions: () => {},
  };
  const ctx = { config, appRegistry, broadcastAll: () => {} } as unknown as ServerContext;
  agentServer = await startAgentOrigin({ config, publicDir, getCtx: () => ctx });

  // The UI side, with the role the real auth gate would have resolved passed
  // in by the test: routeUiAgentPaths runs after authorizeRequest.
  uiServer = createServer((req, res) => {
    const url = new URL(req.url || "/", "http://127.0.0.1");
    const role = (req.headers["x-test-role"] as Role | undefined) ?? "operator";
    if (!routeUiAgentPaths(req.method || "GET", url, req, res, config, role)) { res.writeHead(599); res.end(); }
  });
  await new Promise<void>((resolve) => uiServer.listen(0, "127.0.0.1", resolve));
  uiBase = `http://127.0.0.1:${(uiServer.address() as AddressInfo).port}`;
});

afterAll(async () => {
  agentServer.closeAllConnections();
  uiServer.closeAllConnections();
  await new Promise<void>((resolve) => agentServer.close(() => resolve()));
  await new Promise<void>((resolve) => uiServer.close(() => resolve()));
  rmSync(root, { recursive: true, force: true });
});

const ui = (path: string, init: RequestInit = {}) => fetch(`${uiBase}${path}`, { redirect: "manual", ...init });
const agent = (path: string, init: RequestInit = {}) => fetch(`${agentOrigin()}${path}`, { redirect: "manual", ...init });
const signed = (rel: string) => `/files/${rel}?sig=${signAgentFilePath(OP_TOKEN, rel)}`;

describe("the two origins are distinct", () => {
  it("the agent origin is a loopback listener on its own port, never the UI's", () => {
    const origin = new URL(agentOrigin());
    expect(origin.hostname).toBe("127.0.0.1");
    expect(origin.port).not.toBe(String(UI_PORT));
    expect(origin.port).not.toBe(new URL(uiBase).port);
  });
});

describe("the UI origin refuses agent paths", () => {
  it("redirects /apps to the agent origin and drops any token from the query", async () => {
    const res = await ui(`/apps/demo/?token=${OP_TOKEN}&ft=x&_t=1`);
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe(`${agentOrigin()}/apps/demo/?_t=1`);
    expect(await res.text()).toBe("");
  });

  it("redirects registry-rendered /dashboards the same way", async () => {
    const res = await ui("/dashboards/board");
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe(`${agentOrigin()}/dashboards/board`);
  });

  it("refuses /files without the files-link capability, including with the operator token", async () => {
    expect((await ui("/files/reports/q3.html")).status).toBe(401);
    expect((await ui(`/files/reports/q3.html?token=${OP_TOKEN}`)).status).toBe(401);
    expect((await ui("/files/reports/q3.html", { headers: { Authorization: `Bearer ${OP_TOKEN}` } })).status).toBe(401);
    expect((await ui("/files/reports/q3.html?ft=not-the-capability")).status).toBe(401);
  });

  it("trades the files-link capability for a signature good for that one file", async () => {
    const ft = deriveFilesLinkCapability(OP_TOKEN);
    const res = await ui(`/files/reports/q3.html?ft=${ft}`);
    expect(res.status).toBe(302);
    const location = res.headers.get("location") ?? "";
    expect(location).toBe(`${agentOrigin()}${signed("reports/q3.html")}`);
    expect(location).not.toContain(OP_TOKEN);
    expect(location).not.toContain(ft);
  });

  it("tells only the operator where the agent origin is", async () => {
    const res = await ui("/api/agent-origin");
    expect(res.status).toBe(200);
    const body = await res.json() as { origin: string; filesLinkToken: string };
    expect(body).toEqual({ origin: agentOrigin(), filesLinkToken: deriveFilesLinkCapability(OP_TOKEN) });
    expect(body.filesLinkToken).not.toBe(OP_TOKEN);
    expect((await ui("/api/agent-origin", { headers: { "x-test-role": "agent" } })).status).toBe(403);
  });

  it("leaves every other path to the UI's own routes", async () => {
    expect((await ui("/app.html")).status).toBe(599);
    expect((await ui("/apps/demo/", { method: "POST" })).status).toBe(599);
  });
});

describe("agent-origin pages carry no operator token and cannot reach the UI", () => {
  it("serves an app framed only by loopback pages, sandboxed without top navigation", async () => {
    const res = await agent("/apps/demo/");
    expect(res.status).toBe(200);
    const csp = res.headers.get("content-security-policy") ?? "";
    expect(csp).toContain("frame-ancestors 'self' http://127.0.0.1:* http://localhost:*");
    expect(csp).toMatch(/sandbox allow-scripts allow-same-origin /);
    expect(csp).not.toContain("allow-top-navigation");
    expect(res.headers.get("x-frame-options")).toBeNull();
    const html = await res.text();
    expect(html).toContain("<title>demo</title>");
    expect(html).not.toContain(OP_TOKEN);
    expect(html).toContain(`window.__LAX_CONNECTOR_TOKEN__=${JSON.stringify(deriveConnectorCapability(OP_TOKEN))}`);
  });

  it("installs the IDE frame bridge addressed to the UI's origins only", async () => {
    const html = await (await agent("/apps/demo/")).text();
    expect(html).toContain(`__laxInstallIdeFrameBridge(["http://127.0.0.1:${UI_PORT}","http://localhost:${UI_PORT}"])`);
    expect(html).toContain("function __laxInstallErrorPipe(");
    expect(html).not.toContain('postMessage(payload,"*")');
  });

  it("gives a phone over the broker the fetch error pipe instead of the frame bridge", async () => {
    const html = await (await agent("/apps/demo/", { headers: { "x-lax-tunnel": "1" } })).text();
    expect(html).not.toContain("__laxInstallIdeFrameBridge(");
    expect(html).toContain("/api/apps/demo/runtime-error");
  });

  it("serves a signed file as a document with no origin of its own", async () => {
    const res = await agent(signed("reports/q3.html"));
    expect(res.status).toBe(200);
    const csp = res.headers.get("content-security-policy") ?? "";
    expect(csp).toMatch(/^sandbox allow-scripts /);
    expect(csp).not.toContain("allow-same-origin");
    expect(res.headers.get("referrer-policy")).toBe("no-referrer");
    expect(await res.text()).toBe("<!doctype html><p>report</p>");
  });

  it("serves a signed SVG with script off", async () => {
    const res = await agent(signed("reports/chart.svg"));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-security-policy")).toContain("script-src 'none'");
  });

  it("refuses a file whose signature names another path, or the operator token in any form", async () => {
    const sibling = `/files/secret.txt?sig=${signAgentFilePath(OP_TOKEN, "reports/q3.html")}`;
    expect((await agent(sibling)).status).toBe(401);
    expect((await agent("/files/secret.txt")).status).toBe(401);
    expect((await agent(`/files/secret.txt?token=${OP_TOKEN}`)).status).toBe(401);
    expect((await agent("/files/secret.txt", { headers: { Authorization: `Bearer ${OP_TOKEN}` } })).status).toBe(401);
  });

  it("reaches the connector proxy with the connector capability, and nothing else under /api", async () => {
    const cap = { Authorization: `Bearer ${deriveConnectorCapability(OP_TOKEN)}` };
    const routed = await agent("/api/connectors/INVALID/x", { headers: cap });
    expect(routed.status).toBe(400);
    expect(await routed.json()).toEqual({ error: "Connector name must be a lowercase slug." });
    expect((await agent("/api/connectors/INVALID/x")).status).toBe(401);
    expect((await agent("/api/connectors/INVALID/x", { headers: { Authorization: `Bearer ${OP_TOKEN}` } })).status).toBe(401);
    expect((await agent("/api/agent-origin", { headers: cap })).status).toBe(401);
    expect((await agent("/api/secrets/X/reveal", { headers: { Authorization: `Bearer ${OP_TOKEN}` } })).status).toBe(401);
  });

  it("renders a registry app with its own state capability, framable by the UI, and no operator token", async () => {
    const res = await agent("/apps/board/");
    expect(res.status).toBe(200);
    expect(res.headers.get("x-frame-options")).toBeNull();
    const csp = res.headers.get("content-security-policy") ?? "";
    expect(csp).toContain("frame-ancestors 'self' http://127.0.0.1:* http://localhost:*");
    expect(csp).not.toContain("allow-top-navigation");
    const html = await res.text();
    expect(html).toContain(`var API = "";`);
    expect(html).toContain(`var AUTH = ${JSON.stringify(deriveAppDataCapability(OP_TOKEN, "board"))};`);
    expect(html).not.toContain(OP_TOKEN);
    expect(html).not.toContain("lax_token");
  });

  it("reaches a registry app's own state calls with that app's capability only", async () => {
    const own = { Authorization: `Bearer ${deriveAppDataCapability(OP_TOKEN, "board")}` };
    const post = (path: string, headers: Record<string, string>) =>
      agent(path, { method: "POST", headers: { ...headers, "Content-Type": "application/json" }, body: JSON.stringify({ type: "click", actionIds: [] }) });
    const state = await agent("/api/apps/board/state", { headers: own });
    expect(state.status).toBe(200);
    expect(await state.json()).toEqual({ componentValues: { n: 1 }, actionQueue: [] });
    expect((await post("/api/apps/board/events", own)).status).toBe(200);
    expect((await post("/api/apps/board/actions/consume", own)).status).toBe(200);

    const other = { Authorization: `Bearer ${deriveAppDataCapability(OP_TOKEN, "other")}` };
    expect((await agent("/api/apps/board/state", { headers: other })).status).toBe(401);
    expect((await agent("/api/apps/board/state", { headers: { Authorization: `Bearer ${OP_TOKEN}` } })).status).toBe(401);
    expect((await agent("/api/apps/board/state")).status).toBe(401);
    // Only the calls the rendered page makes: not a state write, not the app's files.
    expect((await post("/api/apps/board/state", own)).status).toBe(401);
    expect((await agent("/api/apps/board/files", { headers: own })).status).toBe(401);
    expect((await agent("/api/apps/board/audit", { headers: own })).status).toBe(401);
  });

  it("lets the UI's origins read its pages (the gallery's Export), and no other origin", async () => {
    const readBy = async (origin: string) => (await agent("/apps/demo/", { headers: { Origin: origin } })).headers.get("access-control-allow-origin");
    expect(await readBy(`http://127.0.0.1:${UI_PORT}`)).toBe(`http://127.0.0.1:${UI_PORT}`);
    expect(await readBy(`http://localhost:${UI_PORT}`)).toBe(`http://localhost:${UI_PORT}`);
    expect(await readBy("http://127.0.0.1:5173")).toBeNull();
    expect(await readBy(agentOrigin())).toBeNull();
    expect(await readBy("https://evil.example")).toBeNull();
  });

  it("never serves the shell", async () => {
    expect((await agent("/")).status).toBe(404);
    expect((await agent("/app.html")).status).toBe(404);
    expect((await agent("/js/shared.js")).status).toBe(404);
  });

  it("answers only to its own host name (DNS rebinding)", async () => {
    const { port } = new URL(agentOrigin());
    const statusFor = (host: string) => new Promise<number>((resolve, reject) => {
      const req = request({ host: "127.0.0.1", port, path: "/apps/demo/", headers: { host } }, (res) => {
        res.resume();
        resolve(res.statusCode ?? 0);
      });
      req.on("error", reject);
      req.end();
    });
    expect(await statusFor(`rebind.example:${port}`)).toBe(421);
    expect(await statusFor(`127.0.0.1:${UI_PORT}`)).toBe(421);
    expect(await statusFor(`localhost:${port}`)).toBe(200);
    expect(await statusFor(`127.0.0.1:${port}`)).toBe(200);
  });
});

describe("the phone over the broker still opens apps", () => {
  // The tunnel (broker-transport/http-tunnel-bridge.ts) fetches the UI origin
  // with the operator token and follows redirects; the token header must not
  // follow it across origins, and the app must arrive phone-instrumented.
  it("follows the UI redirect to the agent origin with the tunnel marker intact", async () => {
    const res = await fetch(`${uiBase}/apps/demo/`, { headers: { Authorization: `Bearer ${OP_TOKEN}`, "x-lax-tunnel": "1" } });
    expect(res.status).toBe(200);
    expect(new URL(res.url).origin).toBe(agentOrigin());
    const html = await res.text();
    expect(html).toContain("/api/apps/demo/runtime-error");
    expect(html).not.toContain(OP_TOKEN);
  });
});

describe("an everyday /files open, end to end", () => {
  it("follows the UI link to the document on the agent origin", async () => {
    const res = await fetch(`${uiBase}/files/reports/q3.html?ft=${deriveFilesLinkCapability(OP_TOKEN)}`);
    expect(res.status).toBe(200);
    expect(new URL(res.url).origin).toBe(agentOrigin());
    expect(res.url).not.toContain(OP_TOKEN);
    expect(await res.text()).toBe("<!doctype html><p>report</p>");
  });
});

describe("file signatures", () => {
  it("bind one path and rotate with the operator token", () => {
    const sig = signAgentFilePath(OP_TOKEN, "a/b.html");
    expect(verifyAgentFileSignature(OP_TOKEN, "a/b.html", sig)).toBe(true);
    expect(verifyAgentFileSignature(OP_TOKEN, "a/c.html", sig)).toBe(false);
    expect(verifyAgentFileSignature("rotated-token", "a/b.html", sig)).toBe(false);
    expect(verifyAgentFileSignature(OP_TOKEN, "a/b.html", "")).toBe(false);
  });
});
