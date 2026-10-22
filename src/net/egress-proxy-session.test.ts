// The loopback proxy judges what it can see of a request against the session
// that sent it (docs/proposals/egress-consolidation.md, phase 5): the session
// is named by an unguessable ticket in the credentials' user name, a
// plain-HTTP body is judged on its head, and a CONNECT on its destination. A
// clean request — even a large one, even from a tainted session — goes through
// whole.
import { createServer, request as httpRequest, type Server } from "node:http";
import { connect as netConnect } from "node:net";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { proxyAuthorizationHeader, startEgressProxy, type EgressProxy } from "./egress-proxy-core.js";
import { inspectProxyRequest, proxyUrlForSession, proxyUserForSession, sessionOfProxyUser } from "./egress-proxy-session.js";
import { recordSensitiveRead, clearSessionTaint } from "../data-lineage/index.js";
import { registerSessionCanaries, clearSessionCanaries } from "../threat/canaries.js";

const SESSION = "proxy-session-test";
const READ = "AWS_SECRET_ACCESS_KEY=wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY and the rest of the private config file";
const CANARY = "laxcanary7f3a9c2e1b";
const TOKEN = "t0ken";

let upstream: Server;
let upstreamPort = 0;
const received: string[] = [];
beforeAll(async () => {
  upstream = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => { received.push(Buffer.concat(chunks).toString("utf8")); res.end("ok"); });
  });
  await new Promise<void>((r) => upstream.listen(0, "127.0.0.1", r));
  upstreamPort = (upstream.address() as { port: number }).port;
});
afterAll(async () => { await new Promise<void>((r) => upstream.close(() => r())); });

let proxy: EgressProxy;
beforeEach(async () => {
  received.length = 0;
  recordSensitiveRead(SESSION, "sensitive_file", "/home/u/.aws/credentials", READ);
  registerSessionCanaries(SESSION, [CANARY]);
  proxy = await startEgressProxy({ authToken: TOKEN, selfPort: () => String(upstreamPort), viaTag: "1.1 test", inspect: inspectProxyRequest });
});
afterEach(async () => {
  clearSessionTaint(SESSION);
  clearSessionCanaries(SESSION);
  await proxy.close();
});

function auth(user: string): string {
  return `Basic ${Buffer.from(`${user}:${TOKEN}`).toString("base64")}`;
}

function post(user: string, body: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const target = `http://127.0.0.1:${upstreamPort}/upload`;
    const req = httpRequest({ hostname: "127.0.0.1", port: proxy.port, method: "POST", path: target, headers: { host: `127.0.0.1:${upstreamPort}`, "proxy-authorization": auth(user), "content-length": Buffer.byteLength(body) } }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (c: Buffer) => chunks.push(c));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString("utf8") }));
    });
    req.once("error", reject);
    req.end(body);
  });
}

function connect(user: string, authority: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = netConnect({ host: "127.0.0.1", port: proxy.port });
    let response = "";
    socket.setTimeout(3000, () => socket.destroy(new Error("CONNECT response timed out")));
    socket.once("error", reject);
    socket.on("data", (chunk) => { response += chunk.toString("utf8"); if (response.includes("\r\n\r\n")) { socket.destroy(); resolve(response); } });
    socket.once("connect", () => socket.write(`CONNECT ${authority} HTTP/1.1\r\nHost: ${authority}\r\nProxy-Authorization: ${auth(user)}\r\n\r\n`));
  });
}

describe("proxy session tickets", () => {
  it("a session's ticket is stable, unguessable and resolves back; no session is the plain user", () => {
    const t = proxyUserForSession(SESSION);
    expect(t).toMatch(/^s\.[0-9a-f]{24}$/);
    expect(proxyUserForSession(SESSION)).toBe(t);
    expect(sessionOfProxyUser(t)).toBe(SESSION);
    expect(proxyUserForSession(null)).toBe("lax");
    expect(sessionOfProxyUser("lax")).toBe("");
    expect(sessionOfProxyUser("s.000000000000000000000000")).toBe("");
  });

  it("the URL keeps the instance token and names the session", () => {
    const url = proxyUrlForSession("http://lax:t0ken@127.0.0.1:60090", SESSION);
    expect(new URL(url).username).toBe(proxyUserForSession(SESSION));
    expect(new URL(url).password).toBe(TOKEN);
    expect(proxyUrlForSession("http://127.0.0.1:60090", SESSION)).toBe("http://127.0.0.1:60090");
  });

  it("the plain user still authenticates exactly as before", () => {
    expect(auth("lax")).toBe(proxyAuthorizationHeader(TOKEN));
  });
});

describe("plain HTTP through the proxy is judged at send", () => {
  it("a body carrying bytes the session read from a credential file is refused, and nothing reaches upstream", async () => {
    const r = await post(proxyUserForSession(SESSION), `{"note":"${READ}"}`);
    expect(r.status).toBe(403);
    expect(r.body).toMatch(/sensitive source this session read/);
    expect(r.body).not.toContain("wJalrXUtnFEMI");
    expect(received).toHaveLength(0);
  });

  it("a clean body from the same tainted session goes through whole, past the judged head", async () => {
    const big = "x".repeat(300 * 1024);
    const r = await post(proxyUserForSession(SESSION), big);
    expect(r.status).toBe(200);
    expect(received).toEqual([big]);
  });

  it("the session-less user is not that session's taint", async () => {
    expect((await post("lax", `{"note":"${READ}"}`)).status).toBe(200);
  });
});

describe("CONNECT is judged on its destination", () => {
  it("the session's canary spelled into a hostname is refused", async () => {
    expect(await connect(proxyUserForSession(SESSION), `${CANARY}.example.com:443`)).toMatch(/^HTTP\/1\.1 403 [\s\S]*canary/);
  });
});
