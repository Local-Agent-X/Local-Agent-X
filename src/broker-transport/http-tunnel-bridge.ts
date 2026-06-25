// HttpTunnelBridge — serves the phone's REST calls (app list, sessions, app state, model
// list) over the broker peer's `http` data channel instead of the tailnet HTTP bind.
//
// The phone frames an HTTP request; this bridge proxies it to the desktop's OWN loopback
// server (127.0.0.1:port) and frames the response back. It enforces the SAME device-path
// allowlist the tailnet device token did (isDeviceAllowedPath) — so the broker phone gets
// the DEVICE scope, NOT operator access; it can never reach a path a tailnet device
// couldn't. The loopback request carries the operator token only to satisfy local auth;
// the allowlist is the security boundary (mirrors bridge/upgrade-auth.ts).
//
// Pure over an injected loopback resolver + fetch so it unit-tests with fakes.

import type { ControlTransport } from "../screen-stream/peer.js";
import { isDeviceAllowedPath } from "../bridge/upgrade-auth.js";
import { createLogger } from "../logger.js";

const logger = createLogger("broker-transport.http-tunnel");

/** Cap on a proxied body in either direction (app docs/state/lists are small). */
const MAX_BODY = 8 * 1024 * 1024;

/** Phone → desktop: one framed HTTP request. */
interface TunnelRequest {
  t: "req";
  id: string;
  method: string;
  path: string; // pathname + search, e.g. /api/apps?x=1
  headers?: Record<string, string>;
  body?: string;
}

/** Desktop → phone: the framed response. `body` is text (JSON/HTML); binary media is a
 *  follow-on (it would need base64 framing). */
interface TunnelResponse {
  t: "res";
  id: string;
  status: number;
  headers?: Record<string, string>;
  body: string;
}

export interface HttpTunnelDeps {
  /** The loopback origin (http://127.0.0.1:port) + operator token, read fresh per request
   *  (so a token regeneration is picked up). */
  loopback: () => { origin: string; token: string };
  /** Injectable fetch — defaults to the global (Node 24). */
  fetchImpl?: typeof fetch;
}

/** The http seam the dialer wires the peer's `http` channel into. HttpTunnelBridge is the
 *  real impl; NullHttpChannel drops it (chat/screen-only build, or tests). */
export interface HttpChannel {
  attach(transport: ControlTransport): void;
  close(): void;
}

export class HttpTunnelBridge implements HttpChannel {
  private transport: ControlTransport | null = null;
  private closed = false;
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly deps: HttpTunnelDeps) {
    this.fetchImpl = deps.fetchImpl ?? fetch;
  }

  attach(transport: ControlTransport): void {
    if (this.closed) return;
    this.transport = transport; // re-attachable across peer rebuilds (replaces the prior)
    transport.onMessage((text) => void this.handle(text));
    transport.onClose(() => {
      if (this.transport === transport) this.transport = null; // ignore a stale channel's late close
    });
  }

  close(): void {
    this.closed = true;
    this.transport = null;
  }

  private async handle(text: string): Promise<void> {
    if (this.closed || !this.transport) return;
    let req: TunnelRequest;
    try {
      const raw = JSON.parse(text) as { t?: unknown };
      if (raw?.t !== "req") return; // not a request frame — ignore
      req = raw as TunnelRequest;
    } catch {
      return; // non-JSON noise
    }
    const res = await this.proxy(req);
    if (!this.closed && this.transport) this.transport.send(JSON.stringify(res));
  }

  private async proxy(req: TunnelRequest): Promise<TunnelResponse> {
    // Enforce the device scope: the broker phone reaches ONLY what a tailnet device could.
    const pathname = req.path.split("?")[0] ?? req.path;
    if (!isDeviceAllowedPath(pathname)) {
      return { t: "res", id: req.id, status: 403, body: "forbidden" };
    }
    const { origin, token } = this.deps.loopback();
    try {
      const r = await this.fetchImpl(`${origin}${req.path}`, {
        method: req.method,
        headers: { ...(req.headers ?? {}), Authorization: `Bearer ${token}` },
        ...(req.body !== undefined ? { body: req.body } : {}),
      });
      const body = await r.text();
      return {
        t: "res",
        id: req.id,
        status: r.status,
        headers: { "content-type": r.headers.get("content-type") ?? "application/json" },
        body: body.length > MAX_BODY ? body.slice(0, MAX_BODY) : body,
      };
    } catch (e) {
      logger.warn(`[broker-transport] http tunnel proxy failed: ${(e as Error).message}`);
      return { t: "res", id: req.id, status: 502, body: "tunnel proxy failed" };
    }
  }
}

/** Inert HttpChannel: REST stays on the tailnet (chat/screen-only build / tests). */
export class NullHttpChannel implements HttpChannel {
  attach(_transport: ControlTransport): void {
    /* not tunneled */
  }
  close(): void {
    /* nothing to tear down */
  }
}
