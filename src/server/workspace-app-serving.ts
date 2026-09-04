import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { IncomingMessage, ServerResponse } from "node:http";
import { jsonResponse } from "../server-utils.js";
import { staticBuildDistDir } from "../tools/app-run-target.js";
import { ensureDevServerRunning, readDevServerRecord, registerDevServer, listDevServerRecords } from "../tools/dev-server.js";
import { pidsOnPort } from "../tools/process-session.js";
import { registerFrameworkDevServerFromDisk } from "../canonical-loop/public/build-adapters.js";
import { deriveConnectorCapability } from "./app-connector-auth.js";
import { APP_CONTENT_TYPES, WORKSPACE_APP_HTML_HEADERS, resolveAppStaticFile } from "./app-serving-policy.js";
import { decideFrontendServe, proxyFrontendDevServer } from "./dev-server-proxy.js";
import { phoneErrorPipeScript } from "./error-pipe-inject.js";
import type { LAXConfig } from "../types.js";

export interface AppServingDeps {
  ensureDevServerRunning: typeof ensureDevServerRunning;
  readDevServerRecord: typeof readDevServerRecord;
  proxyFrontendDevServer: typeof proxyFrontendDevServer;
  /** Self-heal: register+start a framework app's dev server on open when it has
   *  no record. No-op for static apps. */
  ensureFrameworkRegistered: (appId: string, appDir: string, laxPort: number) => void;
}

const DEFAULT_DEPS: AppServingDeps = {
  ensureDevServerRunning,
  readDevServerRecord,
  proxyFrontendDevServer,
  ensureFrameworkRegistered: (appId, appDir, laxPort) => {
    registerFrameworkDevServerFromDisk(appDir, appId, laxPort, {
      registerDevServer,
      listDevServerRecords,
      portBound: (port) => pidsOnPort(port).length > 0,
    });
  },
};

export function serveWorkspaceApp(
  method: string,
  url: URL,
  req: IncomingMessage,
  res: ServerResponse,
  config: LAXConfig,
  publicDir: string,
  deps: AppServingDeps = DEFAULT_DEPS,
): boolean {
  if (method !== "GET" || !url.pathname.startsWith("/apps/")) return false;
  const json = (status: number, data: unknown) => jsonResponse(res, status, data, req);
  const appId = url.pathname.split("/")[2];
  const workspace = resolve(config.workspace);
  const distDir = appId ? staticBuildDistDir(join(workspace, "apps", appId)) : null;

  if (!distDir) {
    let frontend = appId ? deps.readDevServerRecord(appId) : null;
    // Self-heal: a framework app with no dev-server record would otherwise fall
    // through to static-serving its Vite shell (which ships raw /src/main.tsx the
    // browser can't run = blank page). Detect the framework on disk and
    // register+start its dev server on open, so the preview works regardless of
    // whether the build ever registered it (e.g. a P-1-terminated build). No-op
    // for genuinely static apps → falls through to file serving below.
    if (!frontend && appId) {
      deps.ensureFrameworkRegistered(appId, join(workspace, "apps", appId), Number(process.env.LAX_PORT ?? "7007"));
      frontend = deps.readDevServerRecord(appId);
    }
    if (frontend && frontend.kind === "frontend") {
      let warm = false;
      try { warm = deps.ensureDevServerRunning(appId).status === "running"; } catch {}
      const decision = decideFrontendServe({
        warm,
        tunneled: !!req.headers["x-lax-tunnel"],
        port: frontend.port,
        pathAndQuery: url.pathname + url.search,
      });
      if (decision.mode === "redirect") {
        res.writeHead(302, { Location: decision.location, "Cache-Control": "no-store" });
        res.end();
        return true;
      }
      deps.proxyFrontendDevServer(req, res, frontend.port, url, deriveConnectorCapability(config.authToken), { publicDir });
      return true;
    }
  }

  const serveRoot = distDir ?? workspace;
  const servePathname = distDir ? (url.pathname.slice(`/apps/${appId}`.length) || "/") : url.pathname;
  // Shared with the app_build smoke gate's local origin (app-serving-policy.ts)
  // so the gate resolves a request to the same file this route would.
  const resolved = resolveAppStaticFile(serveRoot, servePathname, distDir !== null);
  if (resolved.kind === "forbidden") { json(403, { error: "Path traversal blocked" }); return true; }
  if (resolved.kind === "not-found") return false;
  const appFile = resolved.path;

  const ext = appFile.split(".").pop() || "";
  const headers: Record<string, string> = { "Content-Type": APP_CONTENT_TYPES[ext] || "application/octet-stream" };
  if (ext !== "html") {
    res.writeHead(200, headers); res.end(readFileSync(appFile)); return true;
  }

  if (appId) { try { deps.ensureDevServerRunning(appId); } catch {} }
  // Shared with the app_build smoke gate's local origin (app-serving-policy.ts)
  // so the gate loads a build under the SAME policy this route serves it with.
  Object.assign(headers, WORKSPACE_APP_HTML_HEADERS);
  let html = readFileSync(appFile, "utf-8");
  const connectorCapability = deriveConnectorCapability(config.authToken);
  const errorPipe = req.headers["x-lax-tunnel"] && appId ? phoneErrorPipeScript(publicDir, appId) : "";
  const isolation = `<script>sessionStorage.removeItem('lax_token');localStorage.removeItem('lax_token');delete window.__AUTH_TOKEN__;window.__LAX_CONNECTOR_TOKEN__=${JSON.stringify(connectorCapability)};history.replaceState(null,'',location.pathname);</script>` + errorPipe;
  html = html.includes("<head>") ? html.replace("<head>", "<head>" + isolation) : html.includes("<body>") ? html.replace("<body>", "<body>" + isolation) : isolation + html;
  res.writeHead(200, headers); res.end(html); return true;
}
