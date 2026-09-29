// The proxy prerequisites a loopback fence needs (docs/proposals/
// shell-sandbox-reuse-plan.md, step 1): a fixed port range the fence can
// permit ahead of time, failing closed when none of it can be owned, and a
// per-proxy token so the permit — which cannot be scoped to the caged shell —
// does not hand every local process the sanctioned route.
import { createServer as createTcpServer, connect as netConnect, type Server } from "node:net";
import { request as httpRequest } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { proxyAuthorizationHeader, startEgressProxy, type EgressProxy } from "./egress-proxy-core.js";

const active: Array<{ close: () => Promise<void> }> = [];
afterEach(async () => { await Promise.all(active.splice(0).map((p) => p.close())); });

async function start(extra: { ports?: { from: number; to: number }; authToken?: string }): Promise<EgressProxy> {
  const proxy = await startEgressProxy({ ...extra, selfPort: () => "7007", viaTag: "1.1 test" });
  active.push(proxy);
  return proxy;
}

function get(proxy: EgressProxy, target: string, headers: Record<string, string> = {}): Promise<{ status: number; body: string; headers: Record<string, string | string[] | undefined> }> {
  return new Promise((resolve, reject) => {
    const req = httpRequest({ hostname: "127.0.0.1", port: proxy.port, method: "GET", path: target, headers: { host: new URL(target).host, ...headers } }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (c: Buffer) => chunks.push(c));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString("utf8"), headers: res.headers }));
    });
    req.once("error", reject);
    req.end();
  });
}

function connect(proxy: EgressProxy, authority: string, headers = ""): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = netConnect({ host: "127.0.0.1", port: proxy.port });
    let response = "";
    socket.setTimeout(3000, () => socket.destroy(new Error("CONNECT response timed out")));
    socket.once("error", reject);
    socket.on("data", (chunk) => { response += chunk.toString("utf8"); if (response.includes("\r\n\r\n")) { socket.destroy(); resolve(response); } });
    socket.once("connect", () => socket.write(`CONNECT ${authority} HTTP/1.1\r\nHost: ${authority}\r\n${headers}\r\n`));
  });
}

async function occupy(port: number): Promise<Server> {
  const s = createTcpServer();
  await new Promise<void>((resolve, reject) => { s.once("error", reject); s.listen(port, "127.0.0.1", resolve); });
  active.push({ close: () => new Promise((r) => s.close(() => r())) });
  return s;
}

/** A free contiguous range of `size` ports, found by binding ephemeral ports. */
async function freeRange(size: number): Promise<{ from: number; to: number }> {
  for (let attempt = 0; attempt < 20; attempt++) {
    const probe = createTcpServer();
    const from = await new Promise<number>((resolve) => probe.listen(0, "127.0.0.1", () => { const a = probe.address(); resolve(typeof a === "object" && a ? a.port : 0); }));
    await new Promise<void>((r) => probe.close(() => r()));
    const servers: Server[] = [];
    let ok = true;
    for (let p = from; p < from + size; p++) {
      try { servers.push(await occupyQuiet(p)); } catch { ok = false; break; }
    }
    await Promise.all(servers.map((s) => new Promise<void>((r) => s.close(() => r()))));
    if (ok) return { from, to: from + size - 1 };
  }
  throw new Error("no free port range found");
}

function occupyQuiet(port: number): Promise<Server> {
  const s = createTcpServer();
  return new Promise((resolve, reject) => { s.once("error", reject); s.listen(port, "127.0.0.1", () => resolve(s)); });
}

describe("egress proxy — port range", () => {
  it("binds the first free port of the range and reports it", async () => {
    const range = await freeRange(3);
    const proxy = await start({ ports: range });
    expect(proxy.port).toBe(range.from);
    expect(proxy.url).toBe(`http://127.0.0.1:${range.from}`);
  });

  it("skips ports something else owns", async () => {
    const range = await freeRange(3);
    await occupy(range.from);
    const proxy = await start({ ports: range });
    expect(proxy.port).toBe(range.from + 1);
  });

  it("fails closed when the whole range is taken — no silent ephemeral port", async () => {
    const range = await freeRange(2);
    await occupy(range.from);
    await occupy(range.to);
    await expect(start({ ports: range })).rejects.toThrow(/could not own a port in 127\.0\.0\.1:\d+-\d+/);
  });
});

describe("egress proxy — token", () => {
  it("the URL carries the credentials, and a request without them is 407 before any policy or dial", async () => {
    const proxy = await start({ authToken: "t0ken" });
    expect(proxy.url).toBe(`http://lax:t0ken@127.0.0.1:${proxy.port}`);
    const r = await get(proxy, "http://198.51.100.7/x");
    expect(r.status).toBe(407);
    expect(r.headers["proxy-authenticate"]).toContain("Basic");
    expect(r.body).toContain("sandboxed shell");
  });

  it("a wrong token is 407 too; the right one reaches the policy (which answers for the target)", async () => {
    const proxy = await start({ authToken: "t0ken" });
    const wrong = await get(proxy, "http://198.51.100.7/x", { "proxy-authorization": proxyAuthorizationHeader("nope") });
    expect(wrong.status).toBe(407);
    // TEST-NET-2 is refused by the egress policy: 403 proves the request got past the token check.
    const right = await get(proxy, "http://198.51.100.7/x", { "proxy-authorization": proxyAuthorizationHeader("t0ken") });
    expect(right.status).toBe(403);
  });

  it("CONNECT is gated the same way", async () => {
    const proxy = await start({ authToken: "t0ken" });
    expect(await connect(proxy, "198.51.100.7:443")).toMatch(/^HTTP\/1\.1 407 /);
    expect(await connect(proxy, "198.51.100.7:443", `Proxy-Authorization: ${proxyAuthorizationHeader("t0ken")}\r\n`)).toMatch(/^HTTP\/1\.1 403 /);
  });

  it("without a token nothing changes: the browser proxy keeps its open loopback contract", async () => {
    const proxy = await start({});
    expect(proxy.url).toBe(`http://127.0.0.1:${proxy.port}`);
    expect((await get(proxy, "http://198.51.100.7/x")).status).toBe(403);
  });
});
