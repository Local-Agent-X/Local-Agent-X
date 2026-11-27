/**
 * Sending a file whole or one piece of it: an HTTP byte range (RFC 9110 §14).
 *
 * A video player asks for a video in pieces (`Range: bytes=0-`, then the next) and
 * plays the first while the rest arrives. The phone reaches these files through its
 * tunnel, which carries one answer of at most 8 MB (vendor/tunnel.ts); a video sent
 * whole over that was refused as too large (2026-11-26). Answered in pieces of at most
 * MAX_RANGE_BYTES, a video of any length streams, and each piece also fits the phone's
 * per-request wait. A request that asks for no range gets the whole file, as before.
 */
import { closeSync, openSync, readFileSync, readSync, statSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";

/** The largest piece one range answer sends: well under the tunnel's 8 MB answer, and
 *  inside the phone's 15 s wait per request even on a 1 Mbit/s link. A player asks
 *  again for the next while it plays this one. */
export const MAX_RANGE_BYTES = 1024 * 1024;

export type ByteRange = { start: number; end: number };

/** The one byte range a `Range` header asks of a file of `size` bytes, capped to
 *  MAX_RANGE_BYTES; null when it asks for none (absent, several ranges, another unit:
 *  the whole file is sent); "unsatisfiable" when it starts past the end. */
export function byteRangeOf(header: string | undefined, size: number): ByteRange | "unsatisfiable" | null {
  const m = /^bytes=(\d*)-(\d*)$/.exec((header ?? "").trim());
  if (!m || (m[1] === "" && m[2] === "")) return null;
  let start: number;
  let end: number;
  if (m[1] === "") {
    // The last N bytes.
    start = Math.max(0, size - Number(m[2]));
    end = size - 1;
  } else {
    start = Number(m[1]);
    end = m[2] === "" ? size - 1 : Math.min(Number(m[2]), size - 1);
  }
  if (start >= size || end < start) return "unsatisfiable";
  return { start, end: Math.min(end, start + MAX_RANGE_BYTES - 1) };
}

function readPiece(file: string, range: ByteRange): Buffer {
  const piece = Buffer.alloc(range.end - range.start + 1);
  const fd = openSync(file, "r");
  try { readSync(fd, piece, 0, piece.length, range.start); } finally { closeSync(fd); }
  return piece;
}

/** Answer with `file`: the piece the request's `Range` asks for (206), or the whole
 *  file (200) when it asks for none. `headers` are the file's own (type, security). */
export function sendFileOrRange(req: IncomingMessage, res: ServerResponse, file: string, headers: Record<string, string>): void {
  const size = statSync(file).size;
  const range = byteRangeOf(req.headers.range, size);
  const out = { ...headers, "Accept-Ranges": "bytes" };
  if (range === null) {
    res.writeHead(200, out);
    res.end(readFileSync(file));
    return;
  }
  if (range === "unsatisfiable") {
    res.writeHead(416, { ...out, "Content-Range": `bytes */${size}` });
    res.end();
    return;
  }
  res.writeHead(206, { ...out, "Content-Range": `bytes ${range.start}-${range.end}/${size}` });
  res.end(readPiece(file, range));
}
