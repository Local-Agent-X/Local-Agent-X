// HttpTunnelBridge — serves the phone's REST calls (app list, sessions, app state, model
// list) over the broker peer's `http` data channel instead of the tailnet HTTP bind.
//
// The phone frames an HTTP request; this bridge proxies it to the desktop's OWN loopback
// server (127.0.0.1:port) and frames the response back. It enforces the device-path
// allowlist (isDeviceAllowedPath) — so the broker phone gets a NARROW scope, NOT operator
// access. The loopback request carries the operator token only to satisfy local auth; the
// allowlist is the security boundary (see device-paths.ts).
//
// The frames, the body cap and the chunking that fits a large response under the data
// channel's per-message cap are the shared agentxos contract (vendor/tunnel.ts).
//
// Pure over an injected loopback resolver + fetch so it unit-tests with fakes.

import type { ControlTransport } from "../screen-stream/peer.js";
import { isDeviceAllowedPath } from "./device-paths.js";
import { TUNNEL_MAX_BODY_BYTES, parseTunnelRequest, splitFramed } from "./vendor/protocol.js";
import type { TunnelRequest, TunnelResponse } from "./vendor/protocol.js";
import { createLogger } from "../logger.js";

const logger = createLogger("broker-transport.http-tunnel");

/** Content-types served as utf8 text; everything else is base64-framed as binary. Covers
 *  the document + the asset kinds an agent-built app references (CSS/JS/SVG/JSON). */
function isTextContentType(contentType: string): boolean {
  const ct = contentType.toLowerCase();
  return (
    ct.startsWith("text/") ||
    ct.includes("json") ||
    ct.includes("javascript") ||
    // Real XML types only ("application/xml", "…+xml"). A bare includes("xml")
    // also matched application/vnd.openXMLformats (docx/xlsx/pptx) and decoded
    // Office binaries as lossy UTF-8 text — corrupt on arrival.
    ct.includes("/xml") ||
    ct.includes("+xml") ||
    ct.includes("svg") ||
    ct.includes("ecmascript") ||
    ct.includes("x-www-form-urlencoded")
  );
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
    let req: TunnelRequest | null;
    try {
      req = parseTunnelRequest(JSON.parse(text));
    } catch {
      return; // non-JSON noise
    }
    if (req === null) return; // not a well-formed request frame — ignore
    const res = await this.proxy(req);
    if (!this.closed && this.transport) {
      // Only chunk for a phone that advertised reassembly support (req.chunked);
      // otherwise send the whole frame as before — backward-compatible.
      const payload = JSON.stringify(res);
      if (req.chunked) for (const message of splitFramed(res.id, payload)) this.transport.send(message);
      else this.transport.send(payload);
    }
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
        // x-lax-tunnel marks a request as coming from the phone over the broker,
        // so the /apps proxy can inject the live-reload poller (the phone can't
        // use Vite's HMR websocket) while leaving desktop native HMR untouched.
        headers: { ...(req.headers ?? {}), Authorization: `Bearer ${token}`, "x-lax-tunnel": "1" },
        ...(req.body !== undefined ? { body: req.body } : {}),
      });
      const contentType = r.headers.get("content-type") ?? "application/json";
      const headers = { "content-type": contentType };
      if (isTextContentType(contentType)) {
        const text = await r.text();
        // Oversize is an ERROR, not a truncation: a sliced body parses as a
        // corrupt payload with a 200 status, which is strictly worse than a
        // clean failure the phone can surface ("file too large").
        if (text.length > TUNNEL_MAX_BODY_BYTES) {
          return { t: "res", id: req.id, status: 413, body: `response too large for the tunnel (${text.length} bytes, limit ${TUNNEL_MAX_BODY_BYTES})` };
        }
        return { t: "res", id: req.id, status: r.status, headers, body: text };
      }
      // Binary asset (image/font/document): base64-frame it so it survives the
      // JSON wire. Same oversize rule — a truncated xlsx is a corrupt xlsx.
      const bytes = Buffer.from(await r.arrayBuffer());
      if (bytes.length > TUNNEL_MAX_BODY_BYTES) {
        return { t: "res", id: req.id, status: 413, body: `response too large for the tunnel (${bytes.length} bytes, limit ${TUNNEL_MAX_BODY_BYTES})` };
      }
      return {
        t: "res",
        id: req.id,
        status: r.status,
        headers,
        enc: "base64",
        body: bytes.toString("base64"),
      };
    } catch (e) {
      logger.warn(`[broker-transport] http tunnel proxy failed: ${(e as Error).message}`);
      return { t: "res", id: req.id, status: 502, body: "tunnel proxy failed" };
    }
  }
}

/** Inert HttpChannel: REST is not tunneled (chat/screen-only build / tests). */
export class NullHttpChannel implements HttpChannel {
  attach(_transport: ControlTransport): void {
    /* not tunneled */
  }
  close(): void {
    /* nothing to tear down */
  }
}
