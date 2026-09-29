import { createServer, request as httpRequest, type IncomingMessage, type ServerResponse } from "node:http";
import { connect as netConnect, isIP, type Server } from "node:net";
import { timingSafeEqual } from "node:crypto";
import type { Duplex } from "node:stream";
import {
  evaluateEgressForUrl,
  resolveAndPinHost,
} from "../security/layer/index.js";

export interface ProxyDialTarget {
  address: string;
  family: 4 | 6;
  hostname: string;
  port: number;
}

type DialTarget = (target: ProxyDialTarget) => Promise<Duplex>;

type PolicyDenyListener = (info: { target: string; reason: string }) => void;

export interface EgressProxyOptions {
  port?: number;
  /**
   * Bind the first free loopback port in this inclusive range instead of an
   * ephemeral one, and fail when none is free. A cage that permits loopback
   * to a port range (the Windows fence, a future Linux bridge) has to know
   * where the proxy is before the shell runs; an ephemeral port cannot be
   * permitted ahead of time, and a proxy that silently landed elsewhere would
   * leave caged shells with no route while reporting one.
   */
  ports?: { from: number; to: number };
  /**
   * When set, every request and CONNECT must carry `Proxy-Authorization:
   * Basic base64("lax:<token>")`; anything else gets 407. A loopback permit
   * cannot be scoped to the caged shell alone, so the token is what keeps
   * another local process from riding the sanctioned route. The returned URL
   * carries the credentials for the proxy env vars.
   */
  authToken?: string;
  dial?: DialTarget;
  /** Port of the self server the canonical egress policy carves out. */
  selfPort: () => string;
  /** Via-header product token appended to forwarded HTTP requests. */
  viaTag: string;
  /** Observes policy denials (403 class) only — never network errors (502s). */
  onPolicyDeny?: PolicyDenyListener;
}

export interface EgressProxy {
  /** `http://127.0.0.1:<port>`, with `lax:<token>@` when a token is required. */
  url: string;
  port: number;
  close: () => Promise<void>;
}

/** The user name in the proxy URL's credentials; the token is the password. */
export const PROXY_AUTH_USER = "lax";

export function proxyAuthorizationHeader(token: string): string {
  return `Basic ${Buffer.from(`${PROXY_AUTH_USER}:${token}`).toString("base64")}`;
}

function authorized(request: IncomingMessage, token: string | undefined): boolean {
  if (token === undefined) return true;
  const header = request.headers["proxy-authorization"];
  const value = Array.isArray(header) ? header[0] : header;
  if (!value) return false;
  const expected = proxyAuthorizationHeader(token);
  return value.length === expected.length && timingSafeEqual(Buffer.from(value), Buffer.from(expected));
}

const PROXY_AUTH_REQUIRED = "Proxy authentication required: this route is for the sandboxed shell, which carries the token in its proxy environment.";

function writeAuthRequired(response: ServerResponse): void {
  response.writeHead(407, {
    "proxy-authenticate": 'Basic realm="lax-egress"',
    "content-type": "text/plain; charset=utf-8",
    "content-length": Buffer.byteLength(PROXY_AUTH_REQUIRED),
    connection: "close",
  });
  response.end(PROXY_AUTH_REQUIRED);
}

function writeSocketAuthRequired(socket: Duplex): void {
  socket.end(
    "HTTP/1.1 407 Proxy Authentication Required\r\n" +
    'Proxy-Authenticate: Basic realm="lax-egress"\r\n' +
    `Content-Type: text/plain; charset=utf-8\r\nContent-Length: ${Buffer.byteLength(PROXY_AUTH_REQUIRED)}\r\n` +
    `Connection: close\r\n\r\n${PROXY_AUTH_REQUIRED}`,
  );
}

class ProxyPolicyError extends Error {}

function cleanHostname(hostname: string): string {
  return hostname.replace(/^\[/, "").replace(/\]$/, "").toLowerCase();
}

function policyDeny(
  reason: string,
  target: string,
  onPolicyDeny: PolicyDenyListener | undefined,
): ProxyPolicyError {
  // INVARIANT: a throwing deny observer must never break the proxy's own 403 response.
  try {
    onPolicyDeny?.({ target, reason });
  } catch { /* observer failure is the observer's problem; the denial still ships */ }
  return new ProxyPolicyError(reason);
}

async function resolveDialTarget(
  url: URL,
  selfPort: () => string,
  onPolicyDeny: PolicyDenyListener | undefined,
): Promise<ProxyDialTarget> {
  const decision = evaluateEgressForUrl(url.href, selfPort());
  if (!decision.allowed) throw policyDeny(decision.reason, url.href, onPolicyDeny);

  const hostname = cleanHostname(url.hostname);
  const port = Number(url.port || (url.protocol === "https:" ? 443 : 80));
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw policyDeny("Blocked: invalid target port", url.href, onPolicyDeny);
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
  if (!resolved.ok) throw policyDeny(resolved.reason, url.href, onPolicyDeny);
  if (!resolved.pin) {
    throw policyDeny("Blocked: target did not produce a dial address", url.href, onPolicyDeny);
  }
  return { ...resolved.pin, hostname, port };
}

function dialPinnedTarget(target: ProxyDialTarget): Promise<Duplex> {
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
  selfPort: () => string,
  viaTag: string,
  onPolicyDeny: PolicyDenyListener | undefined,
): Promise<void> {
  const url = parseHttpTarget(request);
  const target = await resolveDialTarget(url, selfPort, onPolicyDeny);
  const socket = await dial(target);
  // The client can disappear while DNS pinning / dialing is awaiting. In that
  // window no request listener owns the new socket yet, so close it here.
  if (request.destroyed && !request.complete) {
    socket.destroy();
    return;
  }
  const headers: Record<string, string | string[] | undefined> = {
    ...request.headers,
    host: url.host,
    via: request.headers.via
      ? `${Array.isArray(request.headers.via) ? request.headers.via.join(", ") : request.headers.via}, ${viaTag}`
      : viaTag,
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
  // pipe() does not forward errors: a client that aborts mid-body would
  // otherwise leave `request` erroring with no listener (same class as the
  // connection-level guard above) and the dialed upstream socket leaked.
  request.once("error", () => upstream.destroy());
  request.once("close", () => {
    // IncomingMessage closes after both normal completion and an early client
    // disconnect. Only the latter owns the upstream: once the full request was
    // received, the upstream may still be producing a legitimate response.
    if (!request.complete) upstream.destroy();
  });
  request.pipe(upstream);
}

async function openTunnel(
  request: IncomingMessage,
  client: Duplex,
  head: Buffer,
  dial: DialTarget,
  selfPort: () => string,
  onPolicyDeny: PolicyDenyListener | undefined,
): Promise<void> {
  const url = parseConnectTarget(request.url);
  const target = await resolveDialTarget(url, selfPort, onPolicyDeny);
  const upstream = await dial(target);
  // The client may have died during the two awaits above (Chrome SIGKILLed
  // by a mid-session browserMode flip) — don't tunnel into a dead socket.
  if (client.destroyed) {
    upstream.destroy();
    return;
  }
  upstream.once("error", (error) => client.destroy(error));
  client.once("error", () => upstream.destroy());
  client.once("close", () => upstream.destroy());
  client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
  if (head.length > 0) upstream.write(head);
  client.pipe(upstream).pipe(client);
}

function listenOn(server: Server, port: number): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const onError = (error: Error) => reject(error);
    server.once("error", onError);
    server.listen(port, "127.0.0.1", () => {
      server.off("error", onError);
      resolve();
    });
  });
}

/** Bind an ephemeral port, the given port, or the first free port of the range. */
async function bind(server: Server, options: EgressProxyOptions): Promise<void> {
  if (!options.ports) {
    await listenOn(server, options.port ?? 0);
    return;
  }
  const { from, to } = options.ports;
  for (let port = from; port <= to; port++) {
    try {
      await listenOn(server, port);
      return;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EADDRINUSE") throw error;
    }
  }
  throw new Error(`egress proxy could not own a port in 127.0.0.1:${from}-${to}; every port is taken`);
}

export async function startEgressProxy(options: EgressProxyOptions): Promise<EgressProxy> {
  const { selfPort, viaTag, onPolicyDeny, authToken } = options;
  const dial = options.dial ?? dialPinnedTarget;
  const server = createServer((request, response) => {
    if (!authorized(request, authToken)) {
      writeAuthRequired(response);
      return;
    }
    void forwardHttp(request, response, dial, selfPort, viaTag, onPolicyDeny)
      .catch((error) => writeHttpError(response, error));
  });
  const clientSockets = new Set<Duplex>();
  server.on("connection", (socket) => {
    clientSockets.add(socket);
    socket.once("close", () => clientSockets.delete(socket));
    // INVARIANT: every socket the proxy owns carries an error handler from
    // the moment it's owned — never only at first use. openTunnel() awaits
    // DNS-pin + upstream dial before ITS handlers attach; when agent Chrome
    // is SIGKILLed mid-CONNECT (browserMode flip → closeAllBrowsers), the
    // client socket RSTs inside that window, and an unhandled 'error' here
    // escalated to a process-wide uncaughtException (read ECONNRESET,
    // 2026-07-20). Handling at acquisition closes every such window at once.
    socket.on("error", () => socket.destroy());
  });
  server.on("connect", (request, socket, head) => {
    if (!authorized(request, authToken)) {
      writeSocketAuthRequired(socket);
      return;
    }
    void openTunnel(request, socket, head, dial, selfPort, onPolicyDeny).catch((error) => writeSocketError(socket, error));
  });

  await bind(server, options).catch((error) => {
    server.close();
    throw error;
  });

  const address = server.address();
  if (!address || typeof address === "string") {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    throw new Error("Egress proxy did not bind a TCP address");
  }

  const credentials = authToken === undefined ? "" : `${PROXY_AUTH_USER}:${authToken}@`;
  return {
    url: `http://${credentials}127.0.0.1:${address.port}`,
    port: address.port,
    close: () => new Promise<void>((resolve, reject) => {
      for (const socket of clientSockets) socket.destroy();
      server.close((error) => error ? reject(error) : resolve());
    }),
  };
}
