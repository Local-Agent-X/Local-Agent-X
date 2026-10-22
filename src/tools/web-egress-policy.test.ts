// canonicalFetch is the one hardened fetch for every off-box read that has no
// URL argument the dispatch gate could judge (web_search, image_search, image
// acquisition for a deck). It applies the web-access policy to the initial
// destination before dialing, so strict mode holds there too, and the error
// carries the policy's action so the tool can offer "Allow <host> & retry".
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assertInitialEgressAllowed, canonicalFetch, EgressRedirectBlocked } from "./web-egress.js";
import { runInEgressScope } from "../net/egress-scope.js";
import { EgressPayloadBlocked } from "../net/egress-send.js";
import { recordSensitiveRead, clearSessionTaint } from "../data-lineage/index.js";

let dir: string;
const prev = process.env.LAX_DATA_DIR;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "lax-egress-fetch-")); process.env.LAX_DATA_DIR = dir; });
afterEach(() => { if (prev === undefined) delete process.env.LAX_DATA_DIR; else process.env.LAX_DATA_DIR = prev; rmSync(dir, { recursive: true, force: true }); });

function strict(allow: string[]): void {
  writeFileSync(join(dir, "security.json"), JSON.stringify({ egressMode: "strict" }));
  writeFileSync(join(dir, "egress-allowlist.json"), JSON.stringify(allow));
}

describe("canonicalFetch applies the web-access policy to its first destination", () => {
  it("strict mode refuses a host off the allowlist before any dial, with the host to allow", async () => {
    strict(["allowed.example"]);
    let thrown: unknown;
    // A host that does not resolve: a rejection from DNS would be a different
    // error, so this proves the policy answered first.
    try { await canonicalFetch("https://html.duckduckgo.invalid/html/?q=x", { timeoutMs: 2_000 }); } catch (e) { thrown = e; }
    expect(thrown).toBeInstanceOf(EgressRedirectBlocked);
    const e = thrown as EgressRedirectBlocked;
    expect(e.action).toEqual({ kind: "allow-host", host: "html.duckduckgo.invalid" });
    expect(e.message).toMatch(/not on the web access allowlist/);
  });

  it("strict mode lets an allowlisted host through the policy (the dial itself is the next step)", () => {
    strict(["html.duckduckgo.com"]);
    expect(() => assertInitialEgressAllowed("https://html.duckduckgo.com/html/?q=x")).not.toThrow();
    expect(() => assertInitialEgressAllowed("https://api.search.brave.com/res/v1/web/search?q=x")).toThrow(EgressRedirectBlocked);
  });

  it("permissive mode has no allowlist to refuse on, and loopback is left to the port-aware check", () => {
    expect(() => assertInitialEgressAllowed("https://docs.example.org/")).not.toThrow();
    expect(() => assertInitialEgressAllowed("http://127.0.0.1:7007/api/health")).not.toThrow();
    expect(() => assertInitialEgressAllowed("http://localhost:3000/")).not.toThrow();
  });

  it("a cloud-metadata or private literal is still refused, without an action", () => {
    expect(() => assertInitialEgressAllowed("not a url")).toThrow(EgressRedirectBlocked);
  });
});

// The operator's configured local image or video server sits on a loopback
// port the agent's loopback grant does not cover. The tool that owns that
// service may reach exactly that origin; nothing else changes.
describe("canonicalFetch reaches an operator-configured local service, and only that", () => {
  let server: Server;
  let base: string;
  let hits: string[];
  beforeEach(async () => {
    hits = [];
    server = createServer((req, res) => {
      hits.push(req.url ?? "");
      if (req.url === "/bounce") { res.writeHead(302, { location: "http://127.0.0.1:1/elsewhere" }); res.end(); return; }
      res.writeHead(200, { "content-type": "text/plain" });
      res.end("ok");
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterEach(async () => {
    delete process.env.LAX_ELECTRON_CDP_PORT;
    await new Promise<void>((r) => server.close(() => r()));
  });

  it("without the option the port is outside the loopback grant and is refused before any dial", async () => {
    await expect(canonicalFetch(`${base}/health`, { timeoutMs: 2_000 })).rejects.toBeInstanceOf(EgressRedirectBlocked);
    expect(hits).toEqual([]);
  });

  it("with the option naming that service, the call goes through", async () => {
    const r = await canonicalFetch(`${base}/health`, { timeoutMs: 2_000, operatorLocalService: base });
    expect(r.status).toBe(200);
    expect(hits).toEqual(["/health"]);
  });

  it("the option covers that origin only: another loopback port is still refused", async () => {
    await expect(canonicalFetch("http://127.0.0.1:1/health", { timeoutMs: 2_000, operatorLocalService: base })).rejects.toBeInstanceOf(EgressRedirectBlocked);
  });

  it("a redirect off the service is judged by the full policy", async () => {
    await expect(canonicalFetch(`${base}/bounce`, { timeoutMs: 2_000, operatorLocalService: base })).rejects.toBeInstanceOf(EgressRedirectBlocked);
    expect(hits).toEqual(["/bounce"]);
  });

  it("a reserved port (the in-app browser's debugging port) is never trusted, even when configured", async () => {
    process.env.LAX_ELECTRON_CDP_PORT = new URL(base).port;
    await expect(canonicalFetch(`${base}/health`, { timeoutMs: 2_000, operatorLocalService: base })).rejects.toBeInstanceOf(EgressRedirectBlocked);
    expect(hits).toEqual([]);
  });
});

// The shared transport carries every redirect rule http_request and web_fetch
// used to implement by hand: a 303 continues as a GET without the body,
// credential headers do not cross origins, the caller can stop a cross-origin
// hop before anything reaches it, and the response names the URL it came from.
describe("canonicalFetch redirects", () => {
  type Seen = { method: string; auth?: string; body: string };
  let a: Server, b: Server;
  let aBase: string, bBase: string;
  let seenA: Seen[], seenB: Seen[];
  const listen = async (seen: Seen[], handle: (url: string, res: import("node:http").ServerResponse) => boolean) => {
    const srv = createServer((req, res) => {
      let body = "";
      req.on("data", (c) => { body += c; });
      req.on("end", () => {
        seen.push({ method: req.method ?? "", auth: req.headers.authorization, body });
        if (!handle(req.url ?? "", res)) { res.writeHead(200); res.end("final"); }
      });
    });
    await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
    return srv;
  };
  beforeEach(async () => {
    seenA = []; seenB = [];
    b = await listen(seenB, () => false);
    bBase = `http://127.0.0.1:${(b.address() as AddressInfo).port}`;
    a = await listen(seenA, (url, res) => {
      const to = url === "/see-other" ? [303, `${bBase}/landed`] : url === "/same" ? [302, "/final"] : url === "/cross" ? [302, `${bBase}/landed`] : null;
      if (!to) return false;
      res.writeHead(to[0] as number, { location: to[1] as string });
      res.end();
      return true;
    });
    aBase = `http://127.0.0.1:${(a.address() as AddressInfo).port}`;
    // Both are local services the user registered, so the loopback grant admits them.
    writeFileSync(join(dir, "security.json"), JSON.stringify({ localServicePorts: [new URL(aBase).port, new URL(bBase).port].map(Number) }));
  });
  afterEach(async () => {
    await new Promise<void>((r) => a.close(() => r()));
    await new Promise<void>((r) => b.close(() => r()));
  });

  it("a 303 continues as a GET without the body", async () => {
    const r = await canonicalFetch(`${aBase}/see-other`, { method: "POST", body: "payload", timeoutMs: 3_000 });
    expect(r.status).toBe(200);
    expect(seenA).toEqual([{ method: "POST", auth: undefined, body: "payload" }]);
    expect(seenB).toEqual([{ method: "GET", auth: undefined, body: "" }]);
  });

  it("a credential header stays on its origin: kept on a same-origin hop, dropped on a cross-origin one", async () => {
    await canonicalFetch(`${aBase}/same`, { headers: { Authorization: "Bearer t" }, timeoutMs: 3_000 });
    expect(seenA.map((s) => s.auth)).toEqual(["Bearer t", "Bearer t"]);
    await canonicalFetch(`${aBase}/cross`, { headers: { Authorization: "Bearer t" }, timeoutMs: 3_000 });
    expect(seenB.map((s) => s.auth)).toEqual([undefined]);
  });

  it("the caller can stop a cross-origin hop before anything reaches the new origin", async () => {
    const stop = new Error("not approved there");
    await expect(canonicalFetch(`${aBase}/cross`, { timeoutMs: 3_000, beforeCrossOriginRedirect: () => { throw stop; } })).rejects.toBe(stop);
    expect(seenB).toEqual([]);
  });

  it("the response names the URL it finally came from", async () => {
    expect((await canonicalFetch(`${aBase}/cross`, { timeoutMs: 3_000 })).url).toBe(`${bBase}/landed`);
    expect((await canonicalFetch(`${aBase}/same`, { timeoutMs: 3_000 })).url).toBe(`${aBase}/final`);
  });
});

// The transport judges the bytes it sends before dialing (net/egress-send.ts):
// a tool call's request that carries what its session read never reaches the
// server; the same session's clean request does.
describe("canonicalFetch judges the bytes it sends", () => {
  let srv: Server;
  let base: string;
  let bodies: string[];
  const SESSION = "web-egress-send-test";
  const READ = "PRIVATE_KEY=-----BEGIN-OPENSSH-PRIVATE-KEY-----b3BlbnNzaC1rZXktdjEAAAAABG5vbmUAAAAE and more of the key file";
  beforeEach(async () => {
    bodies = [];
    srv = createServer((req, res) => { let b = ""; req.on("data", (c) => { b += c; }); req.on("end", () => { bodies.push(b); res.writeHead(200); res.end("ok"); }); });
    await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
    base = `http://127.0.0.1:${(srv.address() as AddressInfo).port}`;
    writeFileSync(join(dir, "security.json"), JSON.stringify({ localServicePorts: [Number(new URL(base).port)] }));
    recordSensitiveRead(SESSION, "sensitive_file", "/home/u/.ssh/id_ed25519", READ);
  });
  afterEach(async () => {
    clearSessionTaint(SESSION);
    await new Promise<void>((r) => srv.close(() => r()));
  });

  it("a body carrying the session's sensitive read is refused before anything is sent", async () => {
    const e = await runInEgressScope(SESSION, () => canonicalFetch(`${base}/upload`, { method: "POST", body: `{"note":"${READ}"}`, timeoutMs: 3_000 })).catch((x) => x);
    expect(e).toBeInstanceOf(EgressPayloadBlocked);
    expect(bodies).toEqual([]);
  });

  it("the same session's clean request goes through", async () => {
    const r = await runInEgressScope(SESSION, () => canonicalFetch(`${base}/upload`, { method: "POST", body: '{"note":"hello"}', timeoutMs: 3_000 }));
    expect(r.status).toBe(200);
    expect(bodies).toEqual(['{"note":"hello"}']);
  });
});
