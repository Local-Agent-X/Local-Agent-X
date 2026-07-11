import { createServer, request as httpRequest, type IncomingMessage, type ServerResponse } from "node:http";
import { connect as netConnect, isIP } from "node:net";
import type { Duplex } from "node:stream";
import {
  evaluateEgressForUrl,
  resolveAndPinHost,
} from "../security/layer/index.js";
import { getRuntimeConfig } from "../config.js";

export interface BrowserProxyDialTarget {
  address: string;
  family: 4 | 6;
  hostname: string;
  port: number;
}

type DialTarget = (target: BrowserProxyDialTarget) => Promise<Duplex>;

export interface BrowserEgressProxyOptions {
  port?: number;
  dial?: DialTarget;
}

export interface BrowserEgressProxy {
  url: string;
  close: () => Promise<void>;
}

class ProxyPolicyError extends Error {}

function selfPort(): string {
  return process.env.LAX_PORT ?? String(getRuntimeConfig().port);
}

function cleanHostname(hostname: string): string {
  return hostname.replace(/^\[/, "").replace(/\]$/, "").toLowerCase();
}

async function resolveDialTarget(url: URL): Promise<BrowserProxyDialTarget> {
  const decision = evaluateEgressForUrl(url.href, selfPort());
  if (!decision.allowed) throw new ProxyPolicyError(decision.reason);

  const hostname = cleanHostname(url.hostname);
  const port = Number(url.port || (url.protocol === "https:" ? 443 : 80));
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new ProxyPolicyError("Blocked: invalid target port");
  }

  // Canonical policy has already restricted these loopback names/addresses to
  // the self server or an explicitly sanctioned local-service port.
  if (hostname === "localhost") {
    return { address: "127.0.0.1", family: 4, hostname, port };
  }
  const literalFamily = isIP(hostname);
  if (literalFamily === 4 || literalFamily === 6) {
    return { address: hostname, family: literalFamily, hostname, port };
  }

  const resolved = await resolveAndPinHost(hostname);
  if (!resolved.ok) throw new ProxyPolicyError(resolved.reason);
  if (!resolved.pin) throw new ProxyPolicyError("Blocked: target did not produce a dial address");
  return { ...resolved.pin, hostname, port };
}

function dialPinnedTarget(target: BrowserProxyDialTarget): Promise<Duplex> {
  return new Promise((resolve, reject) => {
    const socket = netConnect({ host: target.address, port: target.port, family: target.family });
    const onError = (error: Error) => reject(error);
    socket.once("error", onError);
    socket.once("connect", () => {
      socket.off("error", onError);
      resolve(socket);
    });
  });
}

function statusFor(error: unknown): number {
  return error instanceof ProxyPolicyError ? 403 : 502;
}

function messageFor(error: unknown): string {
  return error instanceof Error ? error.message : "Browser proxy request failed";
}

function writeHttpError(response: ServerResponse, error: unknown): void {
  if (response.headersSent) {
    response.destroy(error instanceof Error ? error : undefined);
    return;
  }
  const body = messageFor(error);
  response.writeHead(statusFor(error), {
    "content-type": "text/plain; charset=utf-8",
    "content-length": Buffer.byteLength(body),
    connection: "close",
  });
  response.end(body);
}

function writeSocketError(socket: Duplex, error: unknown): void {
  const status = statusFor(error);
  const body = messageFor(error);
  socket.end(
    `HTTP/1.1 ${status} ${status === 403 ? "Forbidden" : "Bad Gateway"}\r\n` +
    `Content-Type: text/plain; charset=utf-8\r\nContent-Length: ${Buffer.byteLength(body)}\r\n` +
    `Connection: close\r\n\r\n${body}`,
  );
}

function parseHttpTarget(request: IncomingMessage): URL {
  let target: URL;
  try {
    target = new URL(request.url ?? "");
  } catch {
    throw new ProxyPolicyError("Blocked: invalid HTTP proxy target");
  }
  if (target.protocol !== "http:") {
    throw new ProxyPolicyError("Blocked: HTTP proxy requests must use the http scheme");
  }
  return target;
}

export function parseConnectTarget(authority: string | undefined): URL {
  if (!authority || /[\u0000-\u0020\u007f]/.test(authority)) {
    throw new ProxyPolicyError("Blocked: invalid CONNECT authority");
  }

  const match = authority.match(/^(?:\[([0-9a-f:.]+)\]|([a-z0-9.-]+)):(\d{1,5})$/i);
  if (!match) throw new ProxyPolicyError("Blocked: CONNECT requires host:port authority");

  const bracketedIpv6 = match[1];
  const hostname = (bracketedIpv6 ?? match[2]).toLowerCase();
  const port = Number(match[3]);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new ProxyPolicyError("Blocked: invalid CONNECT port");
  }

  if (bracketedIpv6) {
    if (isIP(hostname) !== 6) throw new ProxyPolicyError("Blocked: invalid bracketed IPv6 authority");
  } else if (/^[\d.]+$/.test(hostname)) {
    if (isIP(hostname) !== 4) throw new ProxyPolicyError("Blocked: invalid IPv4 authority");
  } else {
    const dnsName = hostname.endsWith(".") ? hostname.slice(0, -1) : hostname;
    const labels = dnsName.split(".");
    if (dnsName.length === 0 || dnsName.length > 253 || labels.some(
      (label) => label.length === 0 || label.length > 63 ||
        !/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/i.test(label),
    )) {
      throw new ProxyPolicyError("Blocked: invalid CONNECT hostname");
    }
  }

  try {
    return new URL(`https://${bracketedIpv6 ? `[${hostname}]` : hostname}:${port}/`);
  } catch {
    throw new ProxyPolicyError("Blocked: invalid CONNECT authority");
  }
}

async function forwardHttp(
  request: IncomingMessage,
  response: ServerResponse,
  dial: DialTarget,
): Promise<void> {
  const url = parseHttpTarget(request);
  const target = await resolveDialTarget(url);
  const socket = await dial(target);
  const headers: Record<string, string | string[] | undefined> = {
    ...request.headers,
    host: url.host,
    via: request.headers.via
      ? `${Array.isArray(request.headers.via) ? request.headers.via.join(", ") : request.headers.via}, 1.1 lax-browser-egress`
      : "1.1 lax-browser-egress",
  };
  delete headers["proxy-authorization"];
  delete headers["proxy-connection"];

  const upstream = httpRequest({
    method: request.method,
    hostname: target.hostname,
    port: target.port,
    path: `${url.pathname}${url.search}`,
    headers,
    createConnection: () => socket,
  }, (upstreamResponse) => {
    response.writeHead(
      upstreamResponse.statusCode ?? 502,
      upstreamResponse.statusMessage ?? "",
      upstreamResponse.headers,
    );
    upstreamResponse.pipe(response);
  });
  upstream.once("error", (error) => writeHttpError(response, error));
  request.pipe(upstream);
}

async function openTunnel(
  request: IncomingMessage,
  client: Duplex,
  head: Buffer,
  dial: DialTarget,
): Promise<void> {
  const url = parseConnectTarget(request.url);
  const target = await resolveDialTarget(url);
  const upstream = await dial(target);
  upstream.once("error", (error) => client.destroy(error));
  client.once("error", () => upstream.destroy());
  client.once("close", () => upstream.destroy());
  client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
  if (head.length > 0) upstream.write(head);
  client.pipe(upstream).pipe(client);
}

export async function startBrowserEgressProxy(
  options: BrowserEgressProxyOptions = {},
): Promise<BrowserEgressProxy> {
  const dial = options.dial ?? dialPinnedTarget;
  const server = createServer((request, response) => {
    void forwardHttp(request, response, dial).catch((error) => writeHttpError(response, error));
  });
  const clientSockets = new Set<Duplex>();
  server.on("connection", (socket) => {
    clientSockets.add(socket);
    socket.once("close", () => clientSockets.delete(socket));
  });
  server.on("connect", (request, socket, head) => {
    void openTunnel(request, socket, head, dial).catch((error) => writeSocketError(socket, error));
  });

  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error) => reject(error);
    server.once("error", onError);
    server.listen(options.port ?? 0, "127.0.0.1", () => {
      server.off("error", onError);
      resolve();
    });
  }).catch((error) => {
    server.close();
    throw error;
  });

  const address = server.address();
  if (!address || typeof address === "string") {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    throw new Error("Browser egress proxy did not bind a TCP address");
  }

  return {
    url: `http://127.0.0.1:${address.port}`,
    close: () => new Promise<void>((resolve, reject) => {
      for (const socket of clientSockets) socket.destroy();
      server.close((error) => error ? reject(error) : resolve());
    }),
  };
}

let sharedProxy: Promise<BrowserEgressProxy> | null = null;

export function ensureBrowserEgressProxy(): Promise<BrowserEgressProxy> {
  if (!sharedProxy) {
    sharedProxy = startBrowserEgressProxy().catch((error) => {
      sharedProxy = null;
      throw error;
    });
  }
  return sharedProxy;
}

export async function closeBrowserEgressProxy(): Promise<void> {
  const active = sharedProxy;
  sharedProxy = null;
  if (active) await (await active).close();
}
