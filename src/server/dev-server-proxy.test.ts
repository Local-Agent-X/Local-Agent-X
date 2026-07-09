/**
 * Seam: what the frontend dev-server proxy serves when the upstream never binds.
 *
 * Regression for "opening a full-stack app pops a JSON/error window then closes":
 * a Next.js dev server's cold start (npm install + on-demand route compile) can
 * outlast the proxy's inline retry budget. The old code then handed the desktop a
 * bare 502 text/plain, which window.open rendered as a raw error popup. A
 * top-level HTML navigation must instead get a self-reloading "starting…" page
 * (503) so the tab becomes the app once the server binds. Non-HTML requests
 * (assets/subresources) still get the plain 502.
 */
import { describe, it, expect } from "vitest";
import { createServer, request as httpRequest, type Server } from "node:http";
import { AddressInfo } from "node:net";
import { gzipSync } from "node:zlib";
import { proxyFrontendDevServer, decideFrontendServe } from "./dev-server-proxy.js";

/** Drive the proxy against a DEAD upstream port with a near-zero cold-start
 *  budget, capturing the response the proxy writes. */
function runProxy(accept: string): Promise<{ status: number; ct: string; body: string }> {
  return new Promise((resolve, reject) => {
    const server: Server = createServer((req, res) => {
      const url = new URL(`http://127.0.0.1/apps/my-app`);
      // Port 1 is never a dev server → ECONNREFUSED → cold-start retry → deadline.
      proxyFrontendDevServer(
        req, res, /*port*/ 1, url, "cap-token",
        { coldStartWaitMs: 10 },  // expire almost immediately
      );
    });
    server.listen(0, "127.0.0.1", () => {
      const port = (server.address() as AddressInfo).port;
      const reqOpts = { host: "127.0.0.1", port, path: "/apps/my-app", headers: { accept } };
      const r = httpRequest(reqOpts, (up) => {
        let body = "";
        up.on("data", (c) => (body += c));
        up.on("end", () => { server.close(); resolve({ status: up.statusCode || 0, ct: String(up.headers["content-type"] || ""), body }); });
      });
      r.on("error", (e) => { server.close(); reject(e); });
      r.end();
    });
  });
}

describe("proxyFrontendDevServer — cold-start upstream unreachable", () => {
  it("serves a self-reloading 503 HTML page for a top-level HTML navigation", async () => {
    const { status, ct, body } = await runProxy("text/html");
    expect(status).toBe(503);
    expect(ct).toContain("text/html");
    // The page must poll + reload itself (so the tab becomes the app), and must
    // NOT be the old bare error string that window.open renders as a popup.
    expect(body).toContain("location.reload()");
    expect(body.toLowerCase()).toContain("starting");
    expect(body).toContain("My App");  // slug → title-cased label
  });

  it("serves a plain 502 for a non-HTML (asset) request", async () => {
    const { status, ct, body } = await runProxy("application/javascript");
    expect(status).toBe(502);
    expect(ct).toContain("text/plain");
    expect(body).not.toContain("location.reload()");
  });
});

/** Stand up a fake dev server that gzips HTML ONLY when the request asks for it,
 *  then proxy through it. Returns what the client receives + the accept-encoding
 *  the upstream actually saw. */
function runProxyThroughGzipUpstream(): Promise<{
  clientStatus: number; clientEncoding: string | undefined; clientBody: string;
  upstreamSawAcceptEncoding: string | undefined;
}> {
  return new Promise((resolve, reject) => {
    const realHtml = "<html><head></head><body>hello world</body></html>";
    let upstreamSawAcceptEncoding: string | undefined;

    // Upstream: a Next/Vite-like dev server that compresses when Accept-Encoding allows.
    const upstream: Server = createServer((req, res) => {
      upstreamSawAcceptEncoding = req.headers["accept-encoding"] as string | undefined;
      const ae = String(req.headers["accept-encoding"] || "");
      if (ae.includes("gzip")) {
        res.writeHead(200, { "content-type": "text/html; charset=utf-8", "content-encoding": "gzip" });
        res.end(gzipSync(Buffer.from(realHtml)));
      } else {
        res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        res.end(realHtml);
      }
    });

    upstream.listen(0, "127.0.0.1", () => {
      const upstreamPort = (upstream.address() as AddressInfo).port;

      // Front server: run the proxy against the upstream. The BROWSER sends
      // `Accept-Encoding: gzip, br` (the real-world case that broke).
      const front: Server = createServer((req, res) => {
        proxyFrontendDevServer(req, res, upstreamPort, new URL("http://127.0.0.1/apps/my-app"), "cap");
      });
      front.listen(0, "127.0.0.1", () => {
        const frontPort = (front.address() as AddressInfo).port;
        const r = httpRequest(
          { host: "127.0.0.1", port: frontPort, path: "/apps/my-app", headers: { accept: "text/html", "accept-encoding": "gzip, br" } },
          (up) => {
            // Read RAW bytes as-is (no auto-decompress) — if the proxy forwarded a
            // gzip header with a non-gzip body, this is the corrupted text.
            const chunks: Buffer[] = [];
            up.on("data", (c) => chunks.push(c as Buffer));
            up.on("end", () => {
              upstream.close(); front.close();
              resolve({
                clientStatus: up.statusCode || 0,
                clientEncoding: up.headers["content-encoding"] as string | undefined,
                clientBody: Buffer.concat(chunks).toString("utf-8"),
                upstreamSawAcceptEncoding,
              });
            });
          },
        );
        r.on("error", (e) => { upstream.close(); front.close(); reject(e); });
        r.end();
      });
    });
  });
}

describe("decideFrontendServe — desktop-native redirect vs proxy", () => {
  const base = { port: 5178, pathAndQuery: "/apps/spa/assets/x.js?token=abc" };

  it("desktop + warm → redirect straight to the dev server's own origin (native HMR, no proxy)", () => {
    const d = decideFrontendServe({ ...base, warm: true, tunneled: false });
    expect(d).toEqual({ mode: "redirect", location: "http://localhost:5178/apps/spa/assets/x.js?token=abc" });
  });

  it("phone (broker tunnel) → proxy even when warm — it can't reach localhost:<port>", () => {
    expect(decideFrontendServe({ ...base, warm: true, tunneled: true })).toEqual({ mode: "proxy" });
  });

  it("cold server → proxy (the cold-start holding page lives on the proxy path)", () => {
    expect(decideFrontendServe({ ...base, warm: false, tunneled: false })).toEqual({ mode: "proxy" });
  });

  it("preserves the exact path + query on the redirect so subresource URLs and base match", () => {
    const d = decideFrontendServe({ warm: true, tunneled: false, port: 4321, pathAndQuery: "/apps/moneymap-opus/" });
    expect(d).toEqual({ mode: "redirect", location: "http://localhost:4321/apps/moneymap-opus/" });
  });
});

describe("proxyFrontendDevServer — response body encoding", () => {
  it("forces identity upstream and serves decodable HTML (no ERR_CONTENT_DECODING_FAILED)", async () => {
    const r = await runProxyThroughGzipUpstream();
    // The proxy must have asked the upstream for identity, so the buffered body
    // it modifies is real text — never gzip bytes read as UTF-8.
    expect(r.upstreamSawAcceptEncoding).toBe("identity");
    // What reaches the browser must NOT claim gzip (it's modified, uncompressed).
    expect(r.clientEncoding).toBeUndefined();
    // The body is intact, readable HTML with the connector bootstrap injected —
    // NOT gzip garbage. This is the black-screen / decoding-failed regression.
    expect(r.clientStatus).toBe(200);
    expect(r.clientBody).toContain("hello world");
    expect(r.clientBody).toContain("__LAX_CONNECTOR_TOKEN__");
  });
});
