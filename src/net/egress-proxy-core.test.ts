import { Duplex } from "node:stream";
import { connect as netConnect } from "node:net";
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
  startEgressProxy,
  type EgressProxy,
  type EgressProxyOptions,
  type ProxyDialTarget,
} from "./egress-proxy-core.js";

const activeProxies: EgressProxy[] = [];

class RecordingHttpSocket extends Duplex {
  readonly written: Buffer[] = [];
  private sent = false;

  override _read(): void {
    if (this.sent) return;
    this.sent = true;
    this.push("HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: close\r\n\r\nOK");
    this.push(null);
  }

  override _write(
    chunk: Buffer,
    _encoding: BufferEncoding,
    callback: (error?: Error | null) => void,
  ): void {
    this.written.push(chunk);
    callback();
  }
}

async function startCore(options: EgressProxyOptions): Promise<EgressProxy> {
  const proxy = await startEgressProxy(options);
  activeProxies.push(proxy);
  return proxy;
}

function proxyPort(proxy: EgressProxy): number {
  return Number(new URL(proxy.url).port);
}

function requestThroughProxy(proxy: EgressProxy, target: string): Promise<{ status: number; body: string }> {
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

function connectThroughProxy(proxy: EgressProxy, authority: string): Promise<string> {
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
  resolve4.mockReset();
  resolve6.mockReset();
  resolve4.mockResolvedValue([]);
  resolve6.mockResolvedValue([]);
});

afterEach(async () => {
  await Promise.all(activeProxies.splice(0).map((proxy) => proxy.close()));
});

describe("egress proxy core", () => {
  it("stamps the injected viaTag on forwarded HTTP requests", async () => {
    resolve4.mockResolvedValue(["93.184.216.34"]);
    const dialed = new RecordingHttpSocket();
    const dial = vi.fn(async (_target: ProxyDialTarget) => dialed);
    const proxy = await startCore({ dial, selfPort: () => "7007", viaTag: "1.1 test-egress" });

    const response = await requestThroughProxy(proxy, "http://public.example/path");

    expect(response).toEqual({ status: 200, body: "OK" });
    const forwarded = Buffer.concat(dialed.written).toString("utf8");
    expect(forwarded).toContain("via: 1.1 test-egress");
  });

  it("honors the injected selfPort for the loopback self-server carve-out", async () => {
    const dial = vi.fn(async (_target: ProxyDialTarget) => new Duplex({
      read() {},
      write(_chunk, _encoding, callback) { callback(); },
    }));
    const proxy = await startCore({ dial, selfPort: () => "7311", viaTag: "1.1 test-egress" });

    const response = await connectThroughProxy(proxy, "127.0.0.1:7311");

    expect(response).toContain("200 Connection Established");
    expect(dial).toHaveBeenCalledWith({
      address: "127.0.0.1",
      family: 4,
      hostname: "127.0.0.1",
      port: 7311,
    });
  });
});
