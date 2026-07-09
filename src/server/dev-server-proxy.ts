/**
 * Desktop-first reverse proxy for a build-step FRONTEND dev server (Vite / Next /
 * a React/Vue/Svelte SPA). When an app has a `kind: "frontend"` dev-server
 * record, the /apps/<id>/ route hands the request here instead of serving a
 * static file, so the app's own URL streams the live dev server.
 *
 * Desktop-only HMR by design: Vite's hot-reload websocket connects DIRECTLY to
 * localhost:<devPort> from the browser (the dev-relaxed CSP allows ws://
 * localhost:*), so this proxy never has to carry a websocket. That sidesteps the
 * broker's lack of websocket-over-tunnel framing — over the broker the phone
 * still gets the proxied document + assets (full-page reload), just not live HMR.
 */
import { request as httpRequest } from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import { existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { createLogger } from "../logger.js";
import { workspacePath } from "../config.js";
import { phoneErrorPipeScript } from "./error-pipe-inject.js";

const logger = createLogger("server.dev-server-proxy");

// Live-reload over the broker: the phone can't use Vite's HMR websocket, so a
// tiny injected poller (added only for phone requests, marked x-lax-tunnel)
// watches a source-change token over the same HTTP tunnel the page uses and
// full-reloads on a save. Desktop keeps native (state-preserving) HMR untouched.
const LIVERELOAD_PATH = "__lax-livereload";
const TOKEN_SKIP_DIRS = new Set(["node_modules", ".vite", "dist", "build", ".git", "target"]);

/** Newest source mtime under an app's dir (excluding build output) — changes on
 *  any save, which the phone poller compares to trigger a reload. Bounded walk. */
function sourceChangeToken(appId: string): string {
  const root = workspacePath("apps", appId);
  let newest = 0;
  let seen = 0;
  const walk = (dir: string): void => {
    if (seen > 2000) return;
    let entries: string[];
    try { entries = readdirSync(dir); } catch { return; }
    for (const name of entries) {
      if (seen > 2000) return;
      if (TOKEN_SKIP_DIRS.has(name)) continue;
      const full = join(dir, name);
      let st;
      try { st = statSync(full); } catch { continue; }
      if (st.isDirectory()) { walk(full); continue; }
      seen += 1;
      if (st.mtimeMs > newest) newest = st.mtimeMs;
    }
  };
  if (existsSync(root)) walk(root);
  return String(Math.round(newest));
}

function liveReloadScript(appId: string): string {
  const url = `/apps/${appId}/${LIVERELOAD_PATH}`;
  return (
    `<script>(function(){var last=null;setInterval(function(){` +
    `fetch(${JSON.stringify(url)},{cache:'no-store'}).then(function(r){return r.text();})` +
    `.then(function(t){if(last!==null&&t!==last){location.reload();}last=t;}).catch(function(){});` +
    `},2000);})();</script>`
  );
}

/** How to serve one `/apps/<id>/…` request for an app that has a live frontend
 *  dev server. Pure decision, split out so the branch is unit-testable without
 *  standing up a real dev server + the process-session machinery. */
export type FrontendServeDecision =
  | { mode: "redirect"; location: string }
  | { mode: "proxy" };

/**
 * Desktop → a WARM dev server: redirect the browser straight to the server's own
 * origin (`http://localhost:<port>/apps/<id>/…`) so Vite serves everything with
 * native HMR and zero proxy — the "npm run dev in a browser tab" experience.
 * The phone (broker tunnel) can't reach localhost:<port>, and a COLD server needs
 * the proxy's cold-start holding page, so both fall back to the transparent proxy.
 */
export function decideFrontendServe(opts: {
  warm: boolean;
  tunneled: boolean;
  port: number;
  /** The request's `pathname + search`, forwarded verbatim to the native origin. */
  pathAndQuery: string;
}): FrontendServeDecision {
  if (opts.warm && !opts.tunneled) {
    return { mode: "redirect", location: `http://localhost:${opts.port}${opts.pathAndQuery}` };
  }
  return { mode: "proxy" };
}

// Hop-by-hop headers must not be forwarded across a proxy boundary (RFC 7230).
const HOP_BY_HOP = new Set([
  "connection", "keep-alive", "proxy-authenticate", "proxy-authorization",
  "te", "trailers", "transfer-encoding", "upgrade",
]);

// Cold-start tolerance: opening an app kicks its dev server (ensureDevServerRunning),
// but Vite takes a few seconds to bind. Rather than 502 on that gap (a flash the
// user has to reload past), retry the upstream connection until it's ready. A
// WARM server answers on the first attempt — zero added delay; a COLD start waits
// exactly as long as the boot takes; a genuinely-down server 502s after the cap.
const COLD_START_WAIT_MS = 12_000;
const COLD_START_POLL_MS = 300;

// Dev-relaxed CSP, applied ONLY to a proxied frontend-dev document — never the
// static-app path. Vite's dev runtime needs 'unsafe-eval' (module eval) and its
// HMR client needs a ws:/wss: connect-src to reach the dev server on localhost.
const DEV_FRONTEND_CSP =
  "default-src 'self'; " +
  "script-src 'self' 'unsafe-inline' 'unsafe-eval'; " +
  "style-src 'self' 'unsafe-inline'; " +
  "img-src 'self' data: blob:; " +
  "font-src 'self' data:; " +
  "connect-src 'self' http://127.0.0.1:* http://localhost:* ws://127.0.0.1:* ws://localhost:* wss://127.0.0.1:* wss://localhost:*; " +
  "object-src 'none'; base-uri 'self'";

/** Same connector-token bootstrap the static /apps path injects, so a proxied
 *  frontend can still reach a backend through /api/connectors/* and never sees
 *  the operator token. */
function connectorBootstrapScript(connectorToken: string): string {
  return (
    `<script>sessionStorage.removeItem('lax_token');localStorage.removeItem('lax_token');` +
    `delete window.__AUTH_TOKEN__;window.__LAX_CONNECTOR_TOKEN__=${JSON.stringify(connectorToken)};</script>`
  );
}

/** Holding page shown while a frontend dev server is still cold-starting (its
 *  boot outran the proxy's inline retry budget). Polls the same app URL and
 *  swaps itself for the live app the instant the dev server binds — so opening
 *  an app never dumps a raw error at the user, it just says "starting…". */
function devServerStartingPage(appId: string): string {
  const label = appId.replace(/-/g, " ").replace(/\b\w/g, c => c.toUpperCase());
  return (
    `<!doctype html><html><head><meta charset="utf-8">` +
    `<meta name="viewport" content="width=device-width,initial-scale=1">` +
    `<title>${label} — starting…</title><style>` +
    `html,body{height:100%;margin:0}body{display:flex;flex-direction:column;align-items:center;` +
    `justify-content:center;font-family:system-ui,sans-serif;background:#0b0f14;color:#cfe;gap:1rem}` +
    `.spin{width:34px;height:34px;border:3px solid #1e2a38;border-top-color:#3ad;border-radius:50%;` +
    `animation:s 0.8s linear infinite}@keyframes s{to{transform:rotate(360deg)}}` +
    `small{color:#7893}</style></head><body>` +
    `<div class="spin"></div><div>Starting <b>${label}</b>…</div>` +
    `<small>The dev server is booting (npm install + build). This can take up to a minute on first open.</small>` +
    `<script>` +
    // Poll the app URL itself; when it answers 200 with HTML (not this 503 page),
    // reload into the live app.
    `var u=location.href;function ping(){fetch(u,{cache:'no-store',headers:{'x-lax-startpoll':'1'}})` +
    `.then(function(r){if(r.status===200){location.reload();}else{setTimeout(ping,1500);}})` +
    `.catch(function(){setTimeout(ping,1500);});}setTimeout(ping,1500);` +
    `</script></body></html>`
  );
}

function injectHead(html: string, snippet: string): string {
  if (html.includes("<head>")) return html.replace("<head>", "<head>" + snippet);
  if (html.includes("<body>")) return html.replace("<body>", "<body>" + snippet);
  return snippet + html;
}

/**
 * Proxy one GET /apps/<id>/… request to the app's frontend dev server on
 * localhost:<port>. HTML documents are buffered so the connector bootstrap can
 * be injected and the dev CSP applied; everything else (JS modules, assets) is
 * streamed straight through. Writes the full response itself.
 */
export function proxyFrontendDevServer(
  req: IncomingMessage,
  res: ServerResponse,
  port: number,
  url: URL,
  connectorToken: string,
  opts: { coldStartWaitMs?: number; publicDir?: string } = {},
): void {
  // A websocket upgrade (Vite HMR) cannot be proxied here — this forwarder only
  // handles a normal HTTP response, so forwarding an upgrade would HANG (Node
  // routes the 101 to an 'upgrade' event we never read). Fail it FAST so the
  // client's HMR socket gives up immediately instead of wedging the page.
  // Tracked separately for real websocket-over-tunnel support.
  const isUpgrade = String(req.headers.upgrade || "").toLowerCase().includes("websocket");
  if (isUpgrade) {
    logger.info(`[dev-proxy] ws-upgrade FAST-FAIL ${url.pathname} (HMR over tunnel not yet supported)`);
    res.writeHead(501, { "Content-Type": "text/plain" });
    res.end("websocket upgrade not supported on the app proxy yet");
    return;
  }
  const appId = url.pathname.split("/")[2] || "";

  // Live-reload poll endpoint — handled HERE (not forwarded to Vite): return the
  // app's current source-change token so the injected poller can detect a save.
  if (url.pathname.endsWith(`/${LIVERELOAD_PATH}`)) {
    res.writeHead(200, { "Content-Type": "text/plain", "Cache-Control": "no-store" });
    res.end(sourceChangeToken(appId));
    return;
  }

  // Per-request trace so a phone load over the broker is fully visible: which
  // subresources arrive, their status/size, and any error/hang.
  logger.info(`[dev-proxy] → GET ${url.pathname}${url.search}`);

  // Phone requests are marked by the broker tunnel; only those get the live-
  // reload poller (the phone can't use Vite's HMR ws). Desktop keeps native HMR.
  const tunneled = !!req.headers["x-lax-tunnel"];

  const headers: Record<string, string> = {};
  for (const [k, v] of Object.entries(req.headers)) {
    if (typeof v === "string" && !HOP_BY_HOP.has(k.toLowerCase()) && k.toLowerCase() !== "host") {
      headers[k] = v;
    }
  }
  headers.host = `localhost:${port}`;
  // Force IDENTITY encoding upstream. We buffer HTML documents and inject the
  // connector bootstrap into the body — if we let the browser's `Accept-Encoding:
  // gzip, br` reach the dev server, Next/Vite returns a COMPRESSED body that we'd
  // then `.toString("utf-8")` (garbage) and forward with the `Content-Encoding`
  // header still set, so the browser tries to gunzip corrupted bytes and HANGS
  // (the "open pops a JSON viewer / closes" symptom). Asking for identity means
  // the buffered body is real text we can safely modify and re-send uncompressed.
  headers["accept-encoding"] = "identity";

  const deadline = Date.now() + (opts.coldStartWaitMs ?? COLD_START_WAIT_MS);

  const attempt = (): void => {
    const upstream = httpRequest(
      { host: "127.0.0.1", port, method: "GET", path: url.pathname + url.search, headers },
      (up) => {
        const ct = String(up.headers["content-type"] || "");
        logger.info(`[dev-proxy] ← ${up.statusCode} ${url.pathname} (${ct || "no-ct"})`);
        const out: Record<string, string | string[]> = {};
        for (const [k, v] of Object.entries(up.headers)) {
          if (v !== undefined && !HOP_BY_HOP.has(k.toLowerCase()) && k.toLowerCase() !== "content-security-policy") {
            out[k] = v as string | string[];
          }
        }

        if (ct.includes("text/html")) {
          const chunks: Buffer[] = [];
          up.on("data", (c) => chunks.push(c as Buffer));
          up.on("end", () => {
            // Tunneled (phone) documents also get the render-verify capture core —
            // the desktop IDE injects it into its preview iframe itself, but nothing
            // instruments a page the phone loads over the broker.
            const inject = connectorBootstrapScript(connectorToken) +
              (tunneled ? liveReloadScript(appId) + (opts.publicDir ? phoneErrorPipeScript(opts.publicDir, appId) : "") : "");
            const html = injectHead(Buffer.concat(chunks).toString("utf-8"), inject);
            delete out["content-length"];
            // We asked for identity, but strip content-encoding defensively: the
            // body we're sending is modified, uncompressed text, so any inherited
            // encoding header would make the browser mis-decode it and hang.
            delete out["content-encoding"];
            out["Content-Security-Policy"] = DEV_FRONTEND_CSP;
            out["Cache-Control"] = "no-cache, must-revalidate";
            out["X-Content-Type-Options"] = "nosniff";
            res.writeHead(up.statusCode || 200, out);
            res.end(html);
          });
          up.on("error", () => { if (!res.writableEnded) res.end(); });
          return;
        }

        res.writeHead(up.statusCode || 200, out);
        up.pipe(res);
      },
    );

    upstream.on("error", (e) => {
      // Still booting (not listening yet) — retry until the cold-start deadline.
      const code = (e as NodeJS.ErrnoException).code;
      if ((code === "ECONNREFUSED" || code === "ECONNRESET") && !res.headersSent && Date.now() < deadline) {
        setTimeout(attempt, COLD_START_POLL_MS);
        return;
      }
      logger.warn(`[dev-proxy] ✗ ${url.pathname}: ${(e as Error).message}`);
      if (!res.headersSent) {
        // Cold start can outlast the retry budget: `npm install && next dev` on a
        // fresh restart takes far longer than COLD_START_WAIT_MS. A bare 502
        // text/plain gets rendered by the desktop's window.open as a raw error
        // popup (the app "opens then closes"). For a top-level HTML navigation,
        // serve a self-reloading holding page instead so the user sees "starting"
        // and the tab becomes the app the moment the dev server binds. Non-HTML
        // requests (an asset fetch, a subresource) still get the plain 502.
        const wantsHtml = String(req.headers.accept || "").includes("text/html");
        if (wantsHtml) {
          res.writeHead(503, {
            "Content-Type": "text/html; charset=utf-8",
            "Cache-Control": "no-store",
            "Retry-After": "3",
          });
          res.end(devServerStartingPage(appId));
        } else {
          res.writeHead(502, { "Content-Type": "text/plain" });
          res.end("Frontend dev server unreachable — it may still be starting. Reload in a moment.");
        }
      } else if (!res.writableEnded) {
        res.end();
      }
    });
    upstream.end();
  };

  attempt();
}
