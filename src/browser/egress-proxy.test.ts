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
  parseConnectTarget,
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

  it.each([
    ["192.0.2.25", []],
    ["198.51.100.25", []],
    ["203.0.113.25", []],
    ["198.18.0.25", []],
    [undefined, ["2001:db8::25"]],
    [undefined, ["ff02::1"]],
  ])("never dials special-purpose DNS answers (A=%s AAAA=%s)", async (ipv4, ipv6) => {
    resolve4.mockResolvedValue(ipv4 ? [ipv4] : []);
    resolve6.mockResolvedValue(ipv6);
    const dial = vi.fn(async (_target: BrowserProxyDialTarget) => new HttpResponseSocket());
    const proxy = await startWithDial(dial);

    const response = await requestThroughProxy(proxy, "http://special.example/");

    expect(response.status).toBe(403);
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

  it("accepts only bracketed IPv6 CONNECT authority and dials global IPv6", async () => {
    const dial = vi.fn(async (_target: BrowserProxyDialTarget) => tunnelSocket());
    const proxy = await startWithDial(dial);

    const response = await connectThroughProxy(proxy, "[2606:4700:4700::1111]:443");

    expect(response).toContain("200 Connection Established");
    expect(dial).toHaveBeenCalledWith({
      address: "2606:4700:4700::1111",
      family: 6,
      hostname: "2606:4700:4700::1111",
      port: 443,
    });
  });

  it.each([
    undefined,
    "",
    "public.example",
    "public.example:0",
    "public.example:65536",
    "public.example:notaport",
    "user@public.example:443",
    "public.example:443/path",
    "public.example:443#fragment",
    " public.example:443",
    "public.example :443",
    "public.example:\t443",
    "2001:4860:4860::8888:443",
    "[2001:4860:4860::8888]",
    "[not-ipv6]:443",
  ])("strictly rejects malformed CONNECT authority %s", (authority) => {
    expect(() => parseConnectTarget(authority)).toThrow(/Blocked:/);
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

    const ipv6 = await connectThroughProxy(proxy, "[::1]:7007");
    expect(ipv6).toContain("200 Connection Established");
    expect(dial).toHaveBeenCalledWith({
      address: "::1",
      family: 6,
      hostname: "::1",
      port: 7007,
    });
  });

  it("survives the client dying mid-dial without an uncaughtException (2026-07-20 ECONNRESET class)", async () => {
    // Reproduces the crash window: agent Chrome SIGKILLed (browserMode flip →
    // closeAllBrowsers) while a CONNECT tunnel is still awaiting the upstream
    // dial. Before the connection-level error guard, the client socket's RST
    // fired 'error' with no listener → process-wide uncaughtException.
    resolve4.mockResolvedValue(["93.184.216.36"]);
    let releaseDial!: () => void;
    const dialGate = new Promise<void>((r) => { releaseDial = r; });
    const dialed = tunnelSocket();
    const dial = vi.fn(async (_target: BrowserProxyDialTarget) => {
      await dialGate; // hold the tunnel in the pre-handler await window
      return dialed;
    });
    const proxy = await startWithDial(dial);

    const uncaught: Error[] = [];
    const onUncaught = (e: Error) => { uncaught.push(e); };
    process.on("uncaughtException", onUncaught);
    try {
      // Open a CONNECT and kill the client while dial is still pending.
      const clientDead = new Promise<void>((resolve) => {
        const socket = netConnect({ host: "127.0.0.1", port: proxyPort(proxy) }, () => {
          socket.write("CONNECT secure.example:443 HTTP/1.1\r\nHost: secure.example:443\r\n\r\n");
          // Give the proxy a beat to enter openTunnel's awaits, then RST.
          setTimeout(() => {
            socket.resetAndDestroy();
            resolve();
          }, 50);
        });
        socket.on("error", () => { /* client side may see its own reset */ });
      });
      await clientDead;
      releaseDial();
      // Let the held dial resolve and the tunnel path run against the dead client.
      await new Promise((r) => setTimeout(r, 100));

      expect(uncaught).toEqual([]);
      // The dead client's tunnel must not leak the dialed upstream socket.
      expect(dialed.destroyed).toBe(true);

      // And the proxy must still serve new tunnels afterwards.
      const dial2 = vi.fn(async (_target: BrowserProxyDialTarget) => tunnelSocket());
      const proxy2 = await startWithDial(dial2);
      const ok = await connectThroughProxy(proxy2, "secure.example:443");
      expect(ok).toContain("200 Connection Established");
    } finally {
      process.off("uncaughtException", onUncaught);
    }
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
