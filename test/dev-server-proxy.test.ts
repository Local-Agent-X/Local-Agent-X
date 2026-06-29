import { describe, it, expect, afterEach } from "vitest";
import { createServer, type Server, type IncomingMessage, type ServerResponse } from "node:http";
import { AddressInfo } from "node:net";
import { proxyFrontendDevServer } from "../src/server/dev-server-proxy.js";

// Real servers on both ends — the proxy uses res.pipe() for non-HTML, which
// needs a genuine Writable, so http-mocks won't do here.
const open: Server[] = [];
function listen(handler: (req: IncomingMessage, res: ServerResponse) => void): Promise<number> {
  return new Promise((resolve) => {
    const server = createServer(handler);
    open.push(server);
    server.listen(0, "127.0.0.1", () => resolve((server.address() as AddressInfo).port));
  });
}
afterEach(async () => {
  await Promise.all(open.splice(0).map((s) => new Promise<void>((r) => s.close(() => r()))));
});

function proxyTo(port: number) {
  return (req: IncomingMessage, res: ServerResponse) =>
    proxyFrontendDevServer(req, res, port, new URL(req.url!, "http://localhost"), "TOKEN-XYZ");
}

describe("proxyFrontendDevServer (desktop-first live frontend)", () => {
  it("injects the connector token + dev CSP into an HTML document, drops the upstream CSP", async () => {
    const up = await listen((_req, res) => {
      res.writeHead(200, { "Content-Type": "text/html", "Content-Security-Policy": "default-src 'none'" });
      res.end("<html><head><title>Vite</title></head><body>app</body></html>");
    });
    const proxy = await listen(proxyTo(up));

    const r = await fetch(`http://127.0.0.1:${proxy}/apps/spa/`);
    const body = await r.text();

    expect(r.status).toBe(200);
    expect(body).toContain("window.__LAX_CONNECTOR_TOKEN__");
    expect(body).toContain("TOKEN-XYZ");
    expect(body).toContain("<title>Vite</title>");          // upstream document preserved
    const csp = r.headers.get("content-security-policy") || "";
    expect(csp).toContain("ws://localhost:*");              // HMR websocket allowed (desktop)
    expect(csp).toContain("'unsafe-eval'");                 // Vite dev module runtime
    expect(csp).not.toContain("default-src 'none'");        // upstream's CSP is replaced, not forwarded
  });

  it("streams a non-HTML asset through untouched (no token injection)", async () => {
    const up = await listen((_req, res) => {
      res.writeHead(200, { "Content-Type": "application/javascript" });
      res.end("export const x = 1;");
    });
    const proxy = await listen(proxyTo(up));

    const r = await fetch(`http://127.0.0.1:${proxy}/apps/spa/main.js`);
    const body = await r.text();

    expect(r.headers.get("content-type")).toContain("application/javascript");
    expect(body).toBe("export const x = 1;");               // byte-for-byte
    expect(body).not.toContain("__LAX_CONNECTOR_TOKEN__");
  });

  it("forwards the full /apps/<id>/ path (so Vite's base resolves) and query string", async () => {
    let seenPath = "";
    const up = await listen((req, res) => { seenPath = req.url || ""; res.writeHead(200, { "Content-Type": "application/json" }); res.end("{}"); });
    const proxy = await listen(proxyTo(up));

    await fetch(`http://127.0.0.1:${proxy}/apps/spa/assets/index.js?v=abc`);
    expect(seenPath).toBe("/apps/spa/assets/index.js?v=abc");
  });

  it("fast-fails a websocket upgrade (HMR) instead of hanging the page", async () => {
    // A forwarded upgrade would wedge: Node routes the 101 to an 'upgrade' event
    // the forwarder never reads, so the request hangs → white screen on the
    // phone. The proxy must answer immediately. Driven directly (fetch strips
    // the Upgrade header) — no upstream needed, since it returns before forward.
    let status = 0;
    const res = {
      headersSent: false,
      writableEnded: false,
      writeHead(s: number) { status = s; this.headersSent = true; return this; },
      end() { this.writableEnded = true; },
    } as unknown as ServerResponse;
    const req = { headers: { upgrade: "websocket", connection: "Upgrade" } } as unknown as IncomingMessage;

    proxyFrontendDevServer(req, res, 5173, new URL("http://localhost/apps/spa/@vite/client"), "T");
    expect(status).toBe(501);                 // answered, not hung
    expect((res as unknown as { writableEnded: boolean }).writableEnded).toBe(true);
  });

  it("returns 502 when the dev server stays unreachable past the cold-start window", async () => {
    // Grab an ephemeral port, then free it so a connect is refused deterministically.
    const tmp = createServer();
    const deadPort: number = await new Promise((resolve) =>
      tmp.listen(0, "127.0.0.1", () => resolve((tmp.address() as AddressInfo).port)));
    await new Promise<void>((r) => tmp.close(() => r()));
    // Short cold-start window so the test 502s fast instead of waiting the 12s default.
    const proxy = await listen((req, res) =>
      proxyFrontendDevServer(req, res, deadPort, new URL(req.url!, "http://localhost"), "T", { coldStartWaitMs: 200 }));

    const r = await fetch(`http://127.0.0.1:${proxy}/apps/spa/`);
    expect(r.status).toBe(502);
  });

  it("WAITS for a cold-starting dev server and serves once it binds (no 502, no reload)", async () => {
    // Reserve then free a port so the first attempts get ECONNREFUSED (cold start).
    const tmp = createServer();
    const port: number = await new Promise((resolve) =>
      tmp.listen(0, "127.0.0.1", () => resolve((tmp.address() as AddressInfo).port)));
    await new Promise<void>((r) => tmp.close(() => r()));

    const proxy = await listen((req, res) =>
      proxyFrontendDevServer(req, res, port, new URL(req.url!, "http://localhost"), "T", { coldStartWaitMs: 5000 }));

    // The dev server "boots" ~500ms later — the proxy should be mid-retry and then serve.
    setTimeout(() => {
      const up = createServer((_q, s) => {
        s.writeHead(200, { "Content-Type": "text/html" });
        s.end("<html><head></head><body>booted</body></html>");
      });
      open.push(up);
      up.listen(port, "127.0.0.1");
    }, 500);

    const r = await fetch(`http://127.0.0.1:${proxy}/apps/spa/`);
    expect(r.status).toBe(200);
    expect(await r.text()).toContain("booted");
  });
});
