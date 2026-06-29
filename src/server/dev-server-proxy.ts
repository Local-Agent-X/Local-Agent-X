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

// Hop-by-hop headers must not be forwarded across a proxy boundary (RFC 7230).
const HOP_BY_HOP = new Set([
  "connection", "keep-alive", "proxy-authenticate", "proxy-authorization",
  "te", "trailers", "transfer-encoding", "upgrade",
]);

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
): void {
  const headers: Record<string, string> = {};
  for (const [k, v] of Object.entries(req.headers)) {
    if (typeof v === "string" && !HOP_BY_HOP.has(k.toLowerCase()) && k.toLowerCase() !== "host") {
      headers[k] = v;
    }
  }
  headers.host = `localhost:${port}`;

  const upstream = httpRequest(
    { host: "127.0.0.1", port, method: "GET", path: url.pathname + url.search, headers },
    (up) => {
      const ct = String(up.headers["content-type"] || "");
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
          const html = injectHead(Buffer.concat(chunks).toString("utf-8"), connectorBootstrapScript(connectorToken));
          delete out["content-length"];
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

  upstream.on("error", () => {
    if (!res.headersSent) {
      res.writeHead(502, { "Content-Type": "text/plain" });
      res.end("Frontend dev server unreachable — it may still be starting. Reload in a moment.");
    } else if (!res.writableEnded) {
      res.end();
    }
  });
  upstream.end();
}
