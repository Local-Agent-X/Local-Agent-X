// Device REST over the `http` data channel (link.ts). The phone frames an HTTP request;
// the desktop proxies it to its own loopback server, scoped to the device-path
// allowlist, and frames the response back, split into chunks when it is large.

import { asNumber, asRecord, asString, asStringMap } from "./guards.js";
import { parseChunk, type ChunkFrame } from "./chunks.js";

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

/** A frame from the desktop, as the phone reads it: a whole response or one chunk of
 *  one (chunks.ts). */
export function parseTunnelInbound(raw: unknown): TunnelResponse | ChunkFrame | null {
  const chunk = parseChunk(raw);
  if (chunk !== null) return chunk;
  const msg = asRecord(raw);
  if (msg === null || msg.t !== "res") return null;
  const id = asString(msg.id);
  const status = asNumber(msg.status);
  const body = asString(msg.body);
  if (id === null || status === null || body === null) return null;
  const res: TunnelResponse = { t: "res", id, status, body };
  const headers = asStringMap(msg.headers);
  if (headers !== null) res.headers = headers;
  if (msg.enc === "utf8" || msg.enc === "base64") res.enc = msg.enc;
  return res;
}
