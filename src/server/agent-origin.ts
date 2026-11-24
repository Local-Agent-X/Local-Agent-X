/**
 * Two origins, one server process.
 *
 * The UI origin, http://127.0.0.1:<config.port>, serves LAX's own shell and
 * API. Its pages hold the operator token, and the desktop gives the shell's
 * window window.desktop (a host terminal, the file opener, settings). Script
 * that runs on that origin can use both, including script in a same-origin
 * iframe through `parent`.
 *
 * The agent origins serve what the agent wrote, on loopback listeners of this
 * process that are not the UI's. Each app (/apps/<id>/*, /dashboards/<id>/*)
 * has a listener and so an origin of its own (app-origins.ts); workspace files
 * (/files/*) are served by one shared listener, http://127.0.0.1:<ephemeral
 * port>. Because these are different origins, a page from one, even framed
 * inside the shell, cannot touch the shell's DOM, storage, token or
 * window.desktop, and one app's page cannot read another app's: the browser's
 * same-origin policy is the boundary, and the iframe sandbox flags and the
 * pages' CSP are a second line.
 *
 *   - The UI origin serves none of those paths. It redirects /apps and
 *     /dashboards to that app's origin (dropping any token from the query) and
 *     /files to the shared one with a signature for that one file, once the
 *     UI's files-link capability checks out (agent-file-links.ts). GET
 *     /api/agent-origin tells the shell where the shared origin is, and with
 *     ?app=<id> where that app's is, for its frames and its postMessage
 *     origin checks.
 *   - An app's listener serves that app alone. A path of another app, asked of
 *     it or of the shared listener, is redirected to that app's own origin,
 *     which the asking page cannot read.
 *   - Here, no page is given the operator token and none is accepted. The LAX
 *     APIs an app calls are the connector proxy, /api/connectors/*, behind the
 *     connector capability injected into the page, a registry-rendered app's
 *     own state calls, behind a capability bound to that app id, and, for an
 *     app the user allowed, its conversations with the user's agents
 *     (routes/app-chat.ts), behind a capability bound to that app id too (all
 *     three in app-connector-auth.ts). The last two are answered only on that
 *     app's own listener. Every other /api path is refused. An app's
 *     frontend dev server is proxied here too (dev-server-proxy.ts).
 *   - The UI's origins may read the pages served here (CORS on GET), for the
 *     gallery's Export.
 *   - The Host header must name this listener, so a DNS-rebinding page cannot
 *     read it under a name of its own.
 */

import { existsSync, readFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { join, resolve } from "node:path";
import { appIdOfPath, closeAllAppOrigins, ensureAppOrigin, initAppOrigins } from "./app-origins.js";
import { jsonResponse } from "../server-utils.js";
import { authorizeAppConnectorHttp, verifyAppChatCapability, verifyAppDataCapability } from "./app-connector-auth.js";
import { uiOrigins } from "./ide-frame-bridge.js";
import { deriveFilesLinkCapability, signAgentFilePath, verifyFilesLinkCapability } from "./agent-file-links.js";
import { serveAgentFile } from "./static-assets.js";
import { serveWorkspaceApp } from "./workspace-app-serving.js";
import { APP_CONTENT_TYPES, resolveBundledFontFile } from "./app-serving-policy.js";
import { handleAppRoutes } from "../routes/apps.js";
import { handleConnectorProxyRoutes } from "../routes/connector-proxy.js";
import { APP_CHAT_PREFIX, handleAppChatCall } from "../routes/app-chat.js";
import { createLogger } from "../logger.js";
import { setAgentOriginPort } from "../security/layer/agent-origin-port.js";
import type { ServerContext } from "../server-context.js";
import type { LAXConfig } from "../types.js";
import type { Role } from "../rbac.js";

const logger = createLogger("server.agent-origin");

const APP_PATH = /^\/(apps|dashboards)\//;

let listeningPort: number | null = null;

/** This process's agent origin. Bound before the UI origin starts listening. */
export function agentOrigin(): string {
  if (listeningPort === null) throw new Error("The agent origin is not listening yet.");
  return `http://127.0.0.1:${listeningPort}`;
}

export interface AgentOriginDeps {
  config: LAXConfig;
  publicDir: string;
  /** Route context for the registry-app renderer and the connector proxy. */
  getCtx: () => ServerContext;
  /** Where each app's port is remembered; the data dir's file when not given. */
  appPortsFile?: string;
}

/** The two names a loopback listener's origin goes by. */
function listenerOrigins(port: number): string[] {
  return [`http://127.0.0.1:${port}`, `http://localhost:${port}`];
}

function bearerToken(req: IncomingMessage): string {
  const authorization = req.headers.authorization || "";
  return authorization.startsWith("Bearer ") ? authorization.slice(7) : "";
}

const APP_DATA_CALL = /^\/api\/apps\/([a-zA-Z0-9_-]+)\/(state|events|actions\/consume)$/;

/** Which listener a request arrived on: the shared one (files, fonts, the
 *  connector proxy) or one app's own (app-origins.ts). */
export type AgentOriginScope = { kind: "shared" } | { kind: "app"; appId: string; port: () => number };

/** The three calls a registry-rendered app makes for its own state
 *  (app-renderer/client-script.ts), with that app's own capability, on that
 *  app's own listener. */
function isAppDataCall(method: string, pathname: string, token: string, operatorToken: string, scope: AgentOriginScope): boolean {
  const match = pathname.match(APP_DATA_CALL);
  if (!match || scope.kind !== "app" || match[1] !== scope.appId) return false;
  const methodFits = match[2] === "state" ? method === "GET" : method === "POST";
  return methodFits && verifyAppDataCapability(operatorToken, match[1], token);
}

/** An app path on the listener that is that app's is served; on any other
 *  listener it is sent to the app's own origin, where the asking page cannot
 *  read it. */
async function routeAppPath(url: URL, req: IncomingMessage, res: ServerResponse, deps: AgentOriginDeps, scope: AgentOriginScope): Promise<boolean> {
  const appId = appIdOfPath(url.pathname);
  if (!appId) return false;
  if (scope.kind !== "app" || scope.appId !== appId) {
    const origin = await ensureAppOrigin(appId);
    if (!origin) return false;
    redirect(res, origin + url.pathname + url.search);
    return true;
  }
  // A registry-defined app renders here; a workspace app falls through to the
  // static / dev-server route.
  if (await handleAppRoutes("GET", url, req, res, deps.getCtx(), "user")) return true;
  return serveWorkspaceApp("GET", url, req, res, deps.config, deps.publicDir);
}

async function routeAgentRequest(method: string, url: URL, req: IncomingMessage, res: ServerResponse, deps: AgentOriginDeps, scope: AgentOriginScope): Promise<boolean> {
  const { config } = deps;
  if (url.pathname.startsWith("/api/")) {
    const token = bearerToken(req);
    if (isAppDataCall(method, url.pathname, token, config.authToken, scope)) return handleAppRoutes(method, url, req, res, deps.getCtx(), "user");
    // An app's conversations with the user's agents: that app's chat
    // capability, on that app's own listener, from that app's own page.
    if (url.pathname.startsWith(APP_CHAT_PREFIX)) {
      const admitted = scope.kind === "app" && verifyAppChatCapability(config.authToken, scope.appId, token)
        && await handleAppChatCall(method, url, req, res, deps.getCtx(), scope.appId, listenerOrigins(scope.port()));
      if (!admitted) jsonResponse(res, 401, { error: "Unauthorized" }, req);
      return true;
    }
    if (!authorizeAppConnectorHttp(token, url.pathname, config.authToken)) {
      jsonResponse(res, 401, { error: "Unauthorized" }, req);
      return true;
    }
    return handleConnectorProxyRoutes(method, url, req, res, deps.getCtx(), "user");
  }
  // The design system's bundled faces (design-fonts.ts), shared by every app.
  const font = method === "GET" ? resolveBundledFontFile(deps.publicDir, url.pathname) : null;
  if (font) {
    if (font.kind !== "file") { jsonResponse(res, font.kind === "forbidden" ? 403 : 404, { error: "Not found" }, req); return true; }
    const ext = font.path.split(".").pop() || "";
    res.writeHead(200, { "Content-Type": APP_CONTENT_TYPES[ext] || "application/octet-stream", "Cache-Control": "public, max-age=86400", "X-Content-Type-Options": "nosniff" });
    res.end(readFileSync(font.path));
    return true;
  }
  if (APP_PATH.test(url.pathname)) return method === "GET" && routeAppPath(url, req, res, deps, scope);
  // Workspace files are documents with no origin of their own; only the shared
  // listener serves them.
  return scope.kind === "shared" && serveAgentFile(method, url, req, res, config);
}

export function createAgentOriginHandler(deps: AgentOriginDeps, scope: AgentOriginScope = { kind: "shared" }): (req: IncomingMessage, res: ServerResponse) => Promise<void> {
  return async (req, res) => {
    const port = scope.kind === "app" ? scope.port() : listeningPort;
    const host = req.headers.host;
    if (host !== `127.0.0.1:${port}` && host !== `localhost:${port}`) {
      jsonResponse(res, 421, { error: "Misdirected request" }, req);
      return;
    }
    const method = req.method || "GET";
    const url = new URL(req.url || "/", `http://127.0.0.1:${port}`);
    // The UI may read what this origin serves (the app gallery's Export does);
    // never the other way round, and no other loopback page is named here.
    const requester = req.headers.origin;
    if (method === "GET" && requester && uiOrigins(deps.config.port).includes(requester)) {
      res.setHeader("Access-Control-Allow-Origin", requester);
      res.setHeader("Vary", "Origin");
    }
    try {
      if (await routeAgentRequest(method, url, req, res, deps, scope)) return;
      jsonResponse(res, 404, { error: "Not found" }, req);
    } catch (e) {
      // A throw inside a request listener writes no response; without this the
      // page's request would hang until the browser gives up.
      logger.warn(`[agent-origin] ${method} ${url.pathname} failed: ${(e as Error).message}`);
      if (!res.headersSent) jsonResponse(res, 500, { error: "Internal error" }, req);
      else res.end();
    }
  };
}

function appExists(deps: AgentOriginDeps, appId: string): boolean {
  return existsSync(join(resolve(deps.config.workspace), "apps", appId)) || !!deps.getCtx().appRegistry?.get(appId);
}

/** Bind the shared agent origin on an ephemeral loopback port and make ready
 *  the per-app ones. Boot awaits this before the UI origin listens: every UI
 *  redirect to an agent path names one of these ports. Closing the returned
 *  server closes the apps' listeners too. */
export async function startAgentOrigin(deps: AgentOriginDeps): Promise<Server> {
  const server = createServer(createAgentOriginHandler(deps));
  initAppOrigins({
    listenerFor: (appId, port) => createAgentOriginHandler(deps, { kind: "app", appId, port }),
    appExists: (appId) => appExists(deps, appId),
    portsFile: deps.appPortsFile,
  });
  server.on("close", () => { void closeAllAppOrigins(); });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      listeningPort = (server.address() as AddressInfo).port;
      setAgentOriginPort(listeningPort);
      resolve();
    });
  });
  return server;
}

function redirect(res: ServerResponse, location: string): void {
  res.writeHead(302, { Location: location, "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" });
  res.end();
}

/**
 * The UI origin's side: agent paths never render here. Runs before every other
 * UI route, so no route on this origin can serve one.
 */
export async function routeUiAgentPaths(method: string, url: URL, req: IncomingMessage, res: ServerResponse, config: LAXConfig, role: Role): Promise<boolean> {
  if (method === "GET" && url.pathname === "/api/agent-origin") {
    if (role !== "operator") { jsonResponse(res, 403, { error: "Only the operator can read the agent origin." }, req); return true; }
    const body: { origin: string; filesLinkToken: string; appOrigin?: string | null } = { origin: agentOrigin(), filesLinkToken: deriveFilesLinkCapability(config.authToken) };
    // ?app=<id>: that app's own origin, for the shell's frames and its
    // postMessage origin checks. Null when there is no such app.
    const app = url.searchParams.get("app");
    if (app !== null) body.appOrigin = await ensureAppOrigin(app);
    jsonResponse(res, 200, body, req);
    return true;
  }
  if (method !== "GET") return false;
  if (APP_PATH.test(url.pathname)) {
    const appId = appIdOfPath(url.pathname);
    const origin = appId ? await ensureAppOrigin(appId) : null;
    if (!origin) { jsonResponse(res, 404, { error: "No such app." }, req); return true; }
    const target = new URL(url.pathname + url.search, origin);
    target.searchParams.delete("token");
    target.searchParams.delete("ft");
    redirect(res, target.href);
    return true;
  }
  if (url.pathname.startsWith("/files/")) {
    if (!verifyFilesLinkCapability(config.authToken, url.searchParams.get("ft") || "")) {
      jsonResponse(res, 401, { error: "Authentication required" }, req);
      return true;
    }
    let rel: string;
    try { rel = decodeURIComponent(url.pathname.slice("/files/".length)); }
    catch { jsonResponse(res, 400, { error: "The file path is not valid URL encoding." }, req); return true; }
    const target = new URL(url.pathname, agentOrigin());
    target.searchParams.set("sig", signAgentFilePath(config.authToken, rel));
    // The readable view of a document (server/document-view.ts) survives the hop.
    if (url.searchParams.get("view") === "html") target.searchParams.set("view", "html");
    redirect(res, target.href);
    return true;
  }
  return false;
}
