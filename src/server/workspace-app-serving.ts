import { existsSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import type { IncomingMessage, ServerResponse } from "node:http";
import { jsonResponse } from "../server-utils.js";
import { confineToDir } from "../security/file-access.js";
import { staticBuildDistDir } from "../tools/app-run-target.js";
import { ensureDevServerRunning, readDevServerRecord } from "../tools/dev-server.js";
import { deriveConnectorCapability } from "./app-connector-auth.js";
import { decideFrontendServe, proxyFrontendDevServer } from "./dev-server-proxy.js";
import { phoneErrorPipeScript } from "./error-pipe-inject.js";
import type { LAXConfig } from "../types.js";

export interface AppServingDeps {
  ensureDevServerRunning: typeof ensureDevServerRunning;
  readDevServerRecord: typeof readDevServerRecord;
  proxyFrontendDevServer: typeof proxyFrontendDevServer;
}

const DEFAULT_DEPS: AppServingDeps = { ensureDevServerRunning, readDevServerRecord, proxyFrontendDevServer };
const CONTENT_TYPES: Record<string, string> = { html: "text/html", css: "text/css", js: "application/javascript", json: "application/json", png: "image/png", svg: "image/svg+xml", ico: "image/x-icon", webp: "image/webp", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", woff: "font/woff", woff2: "font/woff2", map: "application/json", wasm: "application/wasm", txt: "text/plain" };

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
    const frontend = appId ? deps.readDevServerRecord(appId) : null;
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
  let appFile = confineToDir(serveRoot, "." + servePathname);
  if (!appFile) { json(403, { error: "Path traversal blocked" }); return true; }
  try {
    if (existsSync(appFile) && statSync(appFile).isDirectory()) {
      const index = confineToDir(serveRoot, join(appFile, "index.html"));
      if (index && existsSync(index)) appFile = index;
    }
  } catch {}
  if (distDir && !existsSync(appFile) && !/\.[a-z0-9]+$/i.test(servePathname)) {
    const index = confineToDir(serveRoot, "index.html");
    if (index) appFile = index;
  }
  if (!existsSync(appFile)) return false;

  const ext = appFile.split(".").pop() || "";
  const headers: Record<string, string> = { "Content-Type": CONTENT_TYPES[ext] || "application/octet-stream" };
  if (ext !== "html") {
    res.writeHead(200, headers); res.end(readFileSync(appFile)); return true;
  }

  if (appId) { try { deps.ensureDevServerRunning(appId); } catch {} }
  headers["Content-Security-Policy"] = "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self' http://127.0.0.1:* http://localhost:*; object-src 'none'; base-uri 'self'; form-action 'self'";
  headers["X-Content-Type-Options"] = "nosniff"; headers["X-Frame-Options"] = "SAMEORIGIN"; headers["Referrer-Policy"] = "no-referrer"; headers["Permissions-Policy"] = "camera=(self), microphone=(self), geolocation=()";
  headers["Cache-Control"] = "no-cache, must-revalidate"; headers["Pragma"] = "no-cache";
  let html = readFileSync(appFile, "utf-8");
  const connectorCapability = deriveConnectorCapability(config.authToken);
  const errorPipe = req.headers["x-lax-tunnel"] && appId ? phoneErrorPipeScript(publicDir, appId) : "";
  const isolation = `<script>sessionStorage.removeItem('lax_token');localStorage.removeItem('lax_token');delete window.__AUTH_TOKEN__;window.__LAX_CONNECTOR_TOKEN__=${JSON.stringify(connectorCapability)};history.replaceState(null,'',location.pathname);</script>` + errorPipe;
  html = html.includes("<head>") ? html.replace("<head>", "<head>" + isolation) : html.includes("<body>") ? html.replace("<body>", "<body>" + isolation) : isolation + html;
  res.writeHead(200, headers); res.end(html); return true;
}
