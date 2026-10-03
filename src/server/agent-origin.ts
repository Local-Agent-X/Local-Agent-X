/**
 * Two origins, one server process.
 *
 * The UI origin, http://127.0.0.1:<config.port>, serves LAX's own shell and
 * API. Its pages hold the operator token, and the desktop gives the shell's
 * window window.desktop (a host terminal, the file opener, settings). Script
 * that runs on that origin can use both, including script in a same-origin
 * iframe through `parent`.
 *
 * The agent origin, http://127.0.0.1:<ephemeral port>, serves what the agent
 * wrote: workspace apps (/apps/*, /dashboards/*) and workspace files
 * (/files/*). It is a second loopback listener of this process. Because it is a
 * different origin, a page from it, even one framed inside the shell, cannot
 * touch the shell's DOM, storage, token or window.desktop: the browser's
 * same-origin policy is the boundary, and the iframe sandbox flags and the
 * pages' CSP are a second line.
 *
 *   - The UI origin serves none of those paths. It redirects /apps and
 *     /dashboards here (dropping any token from the query) and /files here with
 *     a signature for that one file, once the UI's files-link capability checks
 *     out (agent-file-links.ts). GET /api/agent-origin tells the shell where
 *     this origin is, for its frames and its postMessage origin checks.
 *   - Here, no page is given the operator token and none is accepted. The LAX
 *     APIs an app calls are the connector proxy, /api/connectors/*, behind the
 *     connector capability injected into the page, and a registry-rendered
 *     app's own state calls, behind a capability bound to that app id (both in
 *     app-connector-auth.ts). Every other /api path is refused. An app's
 *     frontend dev server is proxied here too (dev-server-proxy.ts).
 *   - The UI's origins may read the pages served here (CORS on GET), for the
 *     gallery's Export.
 *   - The Host header must name this listener, so a DNS-rebinding page cannot
 *     read it under a name of its own.
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { jsonResponse } from "../server-utils.js";
import { authorizeAppConnectorHttp, verifyAppDataCapability } from "./app-connector-auth.js";
import { uiOrigins } from "./ide-frame-bridge.js";
import { deriveFilesLinkCapability, signAgentFilePath, verifyFilesLinkCapability } from "./agent-file-links.js";
import { serveAgentFile } from "./static-assets.js";
import { serveWorkspaceApp } from "./workspace-app-serving.js";
import { handleAppRoutes } from "../routes/apps.js";
import { handleConnectorProxyRoutes } from "../routes/connector-proxy.js";
import { createLogger } from "../logger.js";
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
}

function bearerToken(req: IncomingMessage): string {
  const authorization = req.headers.authorization || "";
  return authorization.startsWith("Bearer ") ? authorization.slice(7) : "";
}

const APP_DATA_CALL = /^\/api\/apps\/([a-zA-Z0-9_-]+)\/(state|events|actions\/consume)$/;

/** The three calls a registry-rendered app makes for its own state
 *  (app-renderer/client-script.ts), with that app's own capability. */
function isAppDataCall(method: string, pathname: string, token: string, operatorToken: string): boolean {
  const match = pathname.match(APP_DATA_CALL);
  if (!match) return false;
  const methodFits = match[2] === "state" ? method === "GET" : method === "POST";
  return methodFits && verifyAppDataCapability(operatorToken, match[1], token);
}

async function routeAgentRequest(method: string, url: URL, req: IncomingMessage, res: ServerResponse, deps: AgentOriginDeps): Promise<boolean> {
  const { config } = deps;
  if (url.pathname.startsWith("/api/")) {
    const token = bearerToken(req);
    if (isAppDataCall(method, url.pathname, token, config.authToken)) return handleAppRoutes(method, url, req, res, deps.getCtx(), "user");
    if (!authorizeAppConnectorHttp(token, url.pathname, config.authToken)) {
      jsonResponse(res, 401, { error: "Unauthorized" }, req);
      return true;
    }
    return handleConnectorProxyRoutes(method, url, req, res, deps.getCtx(), "user");
  }
  // A registry-defined app renders here; a workspace app falls through to the
  // static / dev-server route.
  if (method === "GET" && APP_PATH.test(url.pathname) && await handleAppRoutes(method, url, req, res, deps.getCtx(), "user")) return true;
  return serveWorkspaceApp(method, url, req, res, config, deps.publicDir) || serveAgentFile(method, url, req, res, config);
}

export function createAgentOriginHandler(deps: AgentOriginDeps): (req: IncomingMessage, res: ServerResponse) => Promise<void> {
  return async (req, res) => {
    const host = req.headers.host;
    if (host !== `127.0.0.1:${listeningPort}` && host !== `localhost:${listeningPort}`) {
      jsonResponse(res, 421, { error: "Misdirected request" }, req);
      return;
    }
    const method = req.method || "GET";
    const url = new URL(req.url || "/", agentOrigin());
    // The UI may read what this origin serves (the app gallery's Export does);
    // never the other way round, and no other loopback page is named here.
    const requester = req.headers.origin;
    if (method === "GET" && requester && uiOrigins(deps.config.port).includes(requester)) {
      res.setHeader("Access-Control-Allow-Origin", requester);
      res.setHeader("Vary", "Origin");
    }
    try {
      if (await routeAgentRequest(method, url, req, res, deps)) return;
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

/** Bind the agent origin on an ephemeral loopback port. Boot awaits this before
 *  the UI origin listens: every UI redirect to an agent path names this port. */
export async function startAgentOrigin(deps: AgentOriginDeps): Promise<Server> {
  const server = createServer(createAgentOriginHandler(deps));
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      listeningPort = (server.address() as AddressInfo).port;
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
export function routeUiAgentPaths(method: string, url: URL, req: IncomingMessage, res: ServerResponse, config: LAXConfig, role: Role): boolean {
  if (method === "GET" && url.pathname === "/api/agent-origin") {
    if (role !== "operator") { jsonResponse(res, 403, { error: "Only the operator can read the agent origin." }, req); return true; }
    jsonResponse(res, 200, { origin: agentOrigin(), filesLinkToken: deriveFilesLinkCapability(config.authToken) }, req);
    return true;
  }
  if (method !== "GET") return false;
  if (APP_PATH.test(url.pathname)) {
    const target = new URL(url.pathname + url.search, agentOrigin());
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
    const target = new URL(url.pathname, agentOrigin());
    target.searchParams.set("sig", signAgentFilePath(config.authToken, decodeURIComponent(url.pathname.slice("/files/".length))));
    redirect(res, target.href);
    return true;
  }
  return false;
}
