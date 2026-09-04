import { afterEach, describe, expect, it } from "vitest";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { serveWorkspaceApp, type AppServingDeps } from "./workspace-app-serving.js";
import type { LAXConfig } from "../types.js";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

async function requestDevApp(tunneled: boolean, warm: boolean) {
  const root = mkdtempSync(join(tmpdir(), "workspace-app-serving-"));
  roots.push(root);
  const config = { workspace: join(root, "workspace"), authToken: "operator-token" } as LAXConfig;
  let proxied = false;
  const deps: AppServingDeps = {
    readDevServerRecord: () => ({ appId: "dev-app", command: "vite", cwd: root, port: 5173, connector: "dev-dev-app", kind: "frontend" }),
    ensureFrameworkRegistered: () => {}, // record already present — self-heal never fires
    ensureDevServerRunning: () => ({
      status: warm ? "running" : "started",
      record: { appId: "dev-app", command: "vite", cwd: root, port: 5173, connector: "dev-dev-app", kind: "frontend" },
    }),
    proxyFrontendDevServer: (_req: IncomingMessage, res: ServerResponse) => {
      proxied = true;
      res.writeHead(200, { "Content-Type": "text/plain" });
      res.end("proxied");
    },
  };
  const server = createServer((req, res) => {
    const url = new URL(req.url || "/", "http://127.0.0.1");
    if (!serveWorkspaceApp(req.method || "GET", url, req, res, config, root, deps)) {
      res.writeHead(404); res.end();
    }
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  const response = await fetch(`http://127.0.0.1:${port}/apps/dev-app/deep?x=1`, {
    headers: tunneled ? { "x-lax-tunnel": "1" } : {},
    redirect: "manual",
  });
  const result = { status: response.status, location: response.headers.get("location"), body: await response.text(), proxied };
  await new Promise<void>(resolve => server.close(() => resolve()));
  return result;
}

describe("workspace app dev-serving legacy contract", () => {
  it("redirects a warm desktop request with its exact path and query", async () => {
    expect(await requestDevApp(false, true)).toEqual({
      status: 302,
      location: "http://localhost:5173/apps/dev-app/deep?x=1",
      body: "",
      proxied: false,
    });
  });

  it("proxies tunneled and cold requests instead of redirecting", async () => {
    expect(await requestDevApp(true, true)).toEqual({ status: 200, location: null, body: "proxied", proxied: true });
    expect(await requestDevApp(false, false)).toEqual({ status: 200, location: null, body: "proxied", proxied: true });
  });
});

describe("workspace app static file serving", () => {
  // THE production path for a directory request. resolveAppStaticFile answering
  // "not-found" for a directory with no index.html is what keeps this route
  // honest: without it the resolution hands back the DIRECTORY as a file, and
  // this route writes its 200 header and THEN throws EISDIR out of readFileSync
  // — inside the request listener, where (unlike the smoke gate's origin, which
  // has a try/catch backstop) nothing catches it. The response is never ended,
  // so the socket hangs until the client's own timeout. The listener below
  // records any throw so that mutation surfaces as an assertion, not a hang.
  it("answers 404 for a directory with no index.html instead of throwing EISDIR [regression]", async () => {
    const root = mkdtempSync(join(tmpdir(), "workspace-app-serving-dir-"));
    roots.push(root);
    const appDir = join(root, "apps", "demo");
    mkdirSync(join(appDir, "assets"), { recursive: true });
    writeFileSync(join(appDir, "index.html"), "<!doctype html><p>hi</p>");
    writeFileSync(join(appDir, "assets", "app.css"), "body{}");

    const config = { workspace: root, authToken: "operator-token" } as LAXConfig;
    const deps: AppServingDeps = {
      readDevServerRecord: () => null,
      ensureFrameworkRegistered: () => {},
      ensureDevServerRunning: () => { throw new Error("no dev server in this test"); },
      proxyFrontendDevServer: () => { throw new Error("static app must never be proxied"); },
    };
    let thrown: string | null = null;
    const server = createServer((req, res) => {
      const url = new URL(req.url || "/", "http://127.0.0.1");
      try {
        if (!serveWorkspaceApp(req.method || "GET", url, req, res, config, root, deps)) { res.writeHead(404); res.end(); }
      } catch (e) {
        thrown = (e as Error).message;
        if (!res.headersSent) res.writeHead(500);
        res.end();
      }
    });
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as AddressInfo).port;
    const dirRes = await fetch(`http://127.0.0.1:${port}/apps/demo/assets`, { signal: AbortSignal.timeout(5_000) });
    await dirRes.text();
    // …and the route is still serving normally afterwards.
    const fileRes = await fetch(`http://127.0.0.1:${port}/apps/demo/assets/app.css`, { signal: AbortSignal.timeout(5_000) });
    const css = await fileRes.text();
    await new Promise<void>(resolve => server.close(() => resolve()));

    expect(thrown).toBeNull();
    expect(dirRes.status).toBe(404);
    expect(fileRes.status).toBe(200);
    expect(css).toBe("body{}");
  }, 20_000);
});

describe("workspace app dev-serving self-heal (open-time registration)", () => {
  it("registers a framework dev server on open when the app has no record, then proxies", async () => {
    const root = mkdtempSync(join(tmpdir(), "workspace-app-serving-heal-"));
    roots.push(root);
    const config = { workspace: join(root, "workspace"), authToken: "t" } as LAXConfig;
    const rec = () => ({ appId: "heal-app", command: "vite", cwd: root, port: 5173, connector: "c", kind: "frontend" as const });
    let hasRecord = false; // flips true once the self-heal "registers" it
    let registeredAppId = "";
    const deps: AppServingDeps = {
      readDevServerRecord: () => (hasRecord ? rec() : null),
      ensureFrameworkRegistered: (appId) => { registeredAppId = appId; hasRecord = true; },
      ensureDevServerRunning: () => ({ status: "running", record: rec() }),
      proxyFrontendDevServer: (_req: IncomingMessage, res: ServerResponse) => { res.writeHead(200, { "Content-Type": "text/plain" }); res.end("proxied"); },
    };
    const server = createServer((req, res) => {
      const url = new URL(req.url || "/", "http://127.0.0.1");
      if (!serveWorkspaceApp(req.method || "GET", url, req, res, config, root, deps)) { res.writeHead(404); res.end(); }
    });
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as AddressInfo).port;
    const response = await fetch(`http://127.0.0.1:${port}/apps/heal-app/`, { headers: { "x-lax-tunnel": "1" } });
    const body = await response.text();
    await new Promise<void>(resolve => server.close(() => resolve()));

    expect(registeredAppId).toBe("heal-app"); // self-heal fired
    expect(response.status).toBe(200);
    expect(body).toBe("proxied"); // served via the freshly-registered dev server, not static
  });
});
