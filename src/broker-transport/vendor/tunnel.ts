// Device REST over the `http` data channel (link.ts). The phone frames an HTTP request;
// the desktop proxies it to its own loopback server, scoped to the device-path
// allowlist, and frames the response back, split into chunks when it is large.

import { asNumber, asRecord, asString, asStringMap } from "./guards.js";

/** A data channel carries at most ~64 KB per message. 12K characters is at most 48 KB
 *  of UTF-8 (4 bytes per character worst case), safely under it. */
export const MAX_CHUNK_CHARS = 12_288;

/** The largest body the desktop proxies in either direction. */
export const TUNNEL_MAX_BODY_BYTES = 8 * 1024 * 1024;

/** Phone → desktop: one request. `path` is pathname + search (`/api/apps?x=1`). */
export type TunnelRequest = {
  t: "req";
  id: string;
  method: string;
  path: string;
  headers?: Record<string, string>;
  body?: string;
  /** The phone can reassemble chunks. Without it the desktop sends one whole frame. */
  chunked?: boolean;
};

/** Desktop → phone: the response. Absent `enc` means utf8; binary media is base64. */
export type TunnelResponse = {
  t: "res";
  id: string;
  status: number;
  headers?: Record<string, string>;
  enc?: "utf8" | "base64";
  body: string;
};

/** Desktop → phone: slice `i` of `n` of a serialized TunnelResponse. */
export type TunnelChunk = { t: "chunk"; id: string; i: number; n: number; b: string };

export function buildTunnelRequest(
  id: string,
  method: string,
  path: string,
  opts: { headers?: Record<string, string>; body?: string } = {},
): TunnelRequest {
  const req: TunnelRequest = { t: "req", id, method, path, chunked: true };
  if (opts.headers !== undefined) req.headers = opts.headers;
  if (opts.body !== undefined) req.body = opts.body;
  return req;
}

/** A request from the phone, as the desktop reads it. */
export function parseTunnelRequest(raw: unknown): TunnelRequest | null {
  const msg = asRecord(raw);
  if (msg === null || msg.t !== "req") return null;
  const id = asString(msg.id);
  const method = asString(msg.method);
  const path = asString(msg.path);
  if (id === null || method === null || path === null) return null;
  const req: TunnelRequest = { t: "req", id, method, path };
  const headers = asStringMap(msg.headers);
  if (headers !== null) req.headers = headers;
  const body = asString(msg.body);
  if (body !== null) req.body = body;
  if (msg.chunked === true) req.chunked = true;
  return req;
}

/** A frame from the desktop, as the phone reads it: a whole response or one chunk. */
export function parseTunnelInbound(raw: unknown): TunnelResponse | TunnelChunk | null {
  const msg = asRecord(raw);
  if (msg === null) return null;
  const id = asString(msg.id);
  if (id === null) return null;
  if (msg.t === "chunk") {
    const i = asNumber(msg.i);
    const n = asNumber(msg.n);
    const b = asString(msg.b);
    return i !== null && n !== null && b !== null && Number.isInteger(i) && Number.isInteger(n) && i >= 0 && i < n
      ? { t: "chunk", id, i, n, b }
      : null;
  }
  if (msg.t !== "res") return null;
  const status = asNumber(msg.status);
  const body = asString(msg.body);
  if (status === null || body === null) return null;
  const res: TunnelResponse = { t: "res", id, status, body };
  const headers = asStringMap(msg.headers);
  if (headers !== null) res.headers = headers;
  if (msg.enc === "utf8" || msg.enc === "base64") res.enc = msg.enc;
  return res;
}

/** The messages to send for one serialized frame: itself when it fits, else chunks. */
export function splitFramed(id: string, payload: string): string[] {
  if (payload.length <= MAX_CHUNK_CHARS) return [payload];
  const n = Math.ceil(payload.length / MAX_CHUNK_CHARS);
  const out: string[] = [];
  for (let i = 0; i < n; i += 1) {
    const chunk: TunnelChunk = { t: "chunk", id, i, n, b: payload.slice(i * MAX_CHUNK_CHARS, (i + 1) * MAX_CHUNK_CHARS) };
    out.push(JSON.stringify(chunk));
  }
  return out;
}

/** Joins the chunks of each id, in any arrival order; a repeated slice is ignored. */
export class ChunkAssembler {
  private readonly open = new Map<string, { parts: Array<string | undefined>; got: number }>();

  /** The joined payload once the last slice of its id arrives, else null. */
  accept(chunk: TunnelChunk): string | null {
    let buf = this.open.get(chunk.id);
    if (buf === undefined) {
      buf = { parts: new Array<string | undefined>(chunk.n), got: 0 };
      this.open.set(chunk.id, buf);
    }
    if (chunk.i >= buf.parts.length || buf.parts[chunk.i] !== undefined) return null;
    buf.parts[chunk.i] = chunk.b;
    buf.got += 1;
    if (buf.got < buf.parts.length) return null;
    this.open.delete(chunk.id);
    return buf.parts.join("");
  }

  /** Drop every partial payload (the channel closed). */
  clear(): void {
    this.open.clear();
  }
}
