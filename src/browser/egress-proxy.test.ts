import { Duplex } from "node:stream";
import { createServer as createNetServer, connect as netConnect } from "node:net";
import { request as httpRequest } from "node:http";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const resolve4 = vi.fn<(host: string) => Promise<string[]>>();
const resolve6 = vi.fn<(host: string) => Promise<string[]>>();

vi.mock("node:dns", () => ({
  promises: {
    resolve4: (host: string) => resolve4(host),
    resolve6: (host: string) => resolve6(host),
  },
}));

import {
  startBrowserEgressProxy,
  type BrowserEgressProxy,
  type BrowserProxyDialTarget,
} from "./egress-proxy.js";

const activeProxies: BrowserEgressProxy[] = [];
const originalPort = process.env.LAX_PORT;

class HttpResponseSocket extends Duplex {
  private sent = false;

  override _read(): void {
    if (this.sent) return;
    this.sent = true;
    this.push("HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: close\r\n\r\nOK");
    this.push(null);
  }

  override _write(
    _chunk: Buffer,
    _encoding: BufferEncoding,
    callback: (error?: Error | null) => void,
  ): void {
    callback();
  }
}

function tunnelSocket(): Duplex {
  return new Duplex({
    read() {},
    write(_chunk, _encoding, callback) { callback(); },
  });
}

async function startWithDial(
  dial: (target: BrowserProxyDialTarget) => Promise<Duplex>,
): Promise<BrowserEgressProxy> {
  const proxy = await startBrowserEgressProxy({ dial });
  activeProxies.push(proxy);
  return proxy;
}

function proxyPort(proxy: BrowserEgressProxy): number {
  return Number(new URL(proxy.url).port);
}

function requestThroughProxy(proxy: BrowserEgressProxy, target: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const request = httpRequest({
      hostname: "127.0.0.1",
      port: proxyPort(proxy),
      method: "GET",
      path: target,
      headers: { host: new URL(target).host },
    }, (response) => {
      const chunks: Buffer[] = [];
      response.on("data", (chunk: Buffer) => chunks.push(chunk));
      response.on("end", () => resolve({
        status: response.statusCode ?? 0,
        body: Buffer.concat(chunks).toString("utf8"),
      }));
    });
    request.once("error", reject);
    request.end();
  });
}

function connectThroughProxy(proxy: BrowserEgressProxy, authority: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = netConnect({ host: "127.0.0.1", port: proxyPort(proxy) });
    let response = "";
    socket.setTimeout(3000, () => socket.destroy(new Error("CONNECT response timed out")));
    socket.once("error", reject);
    socket.on("data", (chunk) => {
      response += chunk.toString("utf8");
      if (response.includes("\r\n\r\n")) {
        socket.destroy();
        resolve(response);
      }
    });
    socket.once("connect", () => {
      socket.write(`CONNECT ${authority} HTTP/1.1\r\nHost: ${authority}\r\n\r\n`);
    });
  });
}

beforeEach(() => {
  process.env.LAX_PORT = "7007";
  resolve4.mockReset();
  resolve6.mockReset();
  resolve4.mockResolvedValue([]);
  resolve6.mockResolvedValue([]);
});

afterEach(async () => {
  await Promise.all(activeProxies.splice(0).map((proxy) => proxy.close()));
  if (originalPort === undefined) delete process.env.LAX_PORT;
  else process.env.LAX_PORT = originalPort;
});

describe("browser egress proxy", () => {
  it("dials the exact DNS address that passed canonical validation", async () => {
    resolve4.mockResolvedValue(["93.184.216.34"]);
    const dial = vi.fn(async (_target: BrowserProxyDialTarget) => new HttpResponseSocket());
    const proxy = await startWithDial(dial);

    const response = await requestThroughProxy(proxy, "http://public.example/path?q=1");

    expect(response).toEqual({ status: 200, body: "OK" });
    expect(dial).toHaveBeenCalledWith({
      address: "93.184.216.34",
      family: 4,
      hostname: "public.example",
      port: 80,
    });
  });

  it("refuses a private DNS answer before opening a socket", async () => {
    resolve4.mockResolvedValue(["10.0.0.7"]);
    const dial = vi.fn(async (_target: BrowserProxyDialTarget) => new HttpResponseSocket());
    const proxy = await startWithDial(dial);

    const response = await requestThroughProxy(proxy, "http://rebind.example/");

    expect(response.status).toBe(403);
    expect(response.body).toContain("private IP");
    expect(dial).not.toHaveBeenCalled();
  });

  it("pins CONNECT to the validated address while preserving the hostname authority", async () => {
    resolve4.mockResolvedValue(["93.184.216.35"]);
    const dial = vi.fn(async (_target: BrowserProxyDialTarget) => tunnelSocket());
    const proxy = await startWithDial(dial);

    const response = await connectThroughProxy(proxy, "secure.example:443");

    expect(response).toContain("200 Connection Established");
    expect(dial).toHaveBeenCalledWith({
      address: "93.184.216.35",
      family: 4,
      hostname: "secure.example",
      port: 443,
    });
  });

  it("rejects metadata and invalid-port CONNECT targets without dialing", async () => {
    const dial = vi.fn(async (_target: BrowserProxyDialTarget) => tunnelSocket());
    const proxy = await startWithDial(dial);

    const metadata = await connectThroughProxy(proxy, "169.254.169.254:443");
    const invalidPort = await connectThroughProxy(proxy, "public.example:70000");

    expect(metadata).toContain("403 Forbidden");
    expect(invalidPort).toContain("403 Forbidden");
    expect(dial).not.toHaveBeenCalled();
  });

  it("preserves canonical self-server access through the proxy", async () => {
    const dial = vi.fn(async (_target: BrowserProxyDialTarget) => tunnelSocket());
    const proxy = await startWithDial(dial);

    const response = await connectThroughProxy(proxy, "127.0.0.1:7007");

    expect(response).toContain("200 Connection Established");
    expect(dial).toHaveBeenCalledWith({
      address: "127.0.0.1",
      family: 4,
      hostname: "127.0.0.1",
      port: 7007,
    });
  });

  it("fails startup when the listen socket is unavailable", async () => {
    const blocker = createNetServer();
    await new Promise<void>((resolve, reject) => {
      blocker.once("error", reject);
      blocker.listen(0, "127.0.0.1", () => resolve());
    });
    const address = blocker.address();
    if (!address || typeof address === "string") throw new Error("blocker did not bind");

    try {
      await expect(startBrowserEgressProxy({ port: address.port })).rejects.toMatchObject({
        code: "EADDRINUSE",
      });
    } finally {
      await new Promise<void>((resolve, reject) => {
        blocker.close((error) => error ? reject(error) : resolve());
      });
    }
  });
});
