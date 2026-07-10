import { afterEach, describe, expect, it } from "vitest";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtempSync, rmSync } from "node:fs";
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
