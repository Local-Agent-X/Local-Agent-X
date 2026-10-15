// Splitting a frame that is too big for one data-channel message, and joining it back.
// Used by the `http` tunnel (tunnel.ts) and the `chat` channel (chat.ts).
//
// A receiver that can't join chunks drops them, so a sender splits only for a receiver
// that said it can: on the tunnel each request carries `chunked: true`; on the chat
// channel each side sends a LinkHelloFrame when the channel opens.

import { asNumber, asRecord, asString } from "./guards.js";

/** A data channel carries at most ~64 KB per message. 12K characters is at most 48 KB
 *  of UTF-8 (4 bytes per character worst case), safely under it. */
export const MAX_CHUNK_CHARS = 12_288;

/** Slice `i` of `n` of one serialized frame; every slice of a frame shares its `id`. */
export type ChunkFrame = { t: "chunk"; id: string; i: number; n: number; b: string };

/** Sent by each end of the chat channel when it opens: "I can join chunks you send". */
export type LinkHelloFrame = { type: "link_hello"; chunks: true };

export function buildLinkHello(): LinkHelloFrame {
  return { type: "link_hello", chunks: true };
}

export function isLinkHello(raw: unknown): boolean {
  const msg = asRecord(raw);
  return msg !== null && msg.type === "link_hello" && msg.chunks === true;
}

export function parseChunk(raw: unknown): ChunkFrame | null {
  const msg = asRecord(raw);
  if (msg === null || msg.t !== "chunk") return null;
  const id = asString(msg.id);
  const i = asNumber(msg.i);
  const n = asNumber(msg.n);
  const b = asString(msg.b);
  return id !== null && i !== null && n !== null && b !== null && Number.isInteger(i) && Number.isInteger(n) && i >= 0 && i < n
    ? { t: "chunk", id, i, n, b }
    : null;
}

/** The messages to send for one serialized frame: itself when it fits, else chunks. */
export function splitFramed(id: string, payload: string): string[] {
  if (payload.length <= MAX_CHUNK_CHARS) return [payload];
  const n = Math.ceil(payload.length / MAX_CHUNK_CHARS);
  const out: string[] = [];
  for (let i = 0; i < n; i += 1) {
    const chunk: ChunkFrame = { t: "chunk", id, i, n, b: payload.slice(i * MAX_CHUNK_CHARS, (i + 1) * MAX_CHUNK_CHARS) };
    out.push(JSON.stringify(chunk));
  }
  return out;
}

/** Joins the chunks of each id, in any arrival order; a repeated slice is ignored. */
export class ChunkAssembler {
  private readonly open = new Map<string, { parts: Array<string | undefined>; got: number }>();

  /** The joined payload once the last slice of its id arrives, else null. */
  accept(chunk: ChunkFrame): string | null {
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

/** One end of a channel that carries whole JSON frames, chunked both ways once each side
 *  has said it can join (the chat channel). One per channel: a replaced channel gets a
 *  new ChunkedLink, since the end on the other side may be a different build. */
export class ChunkedLink {
  private readonly joiner = new ChunkAssembler();
  private peerJoins = false;
  private seq = 0;

  /** Send this first on a fresh channel. */
  hello(): string {
    return JSON.stringify(buildLinkHello());
  }

  /** The messages to send for one serialized frame: whole until the other end said
   *  it can join chunks. */
  outgoing(payload: string): string[] {
    if (!this.peerJoins) return [payload];
    this.seq += 1;
    return splitFramed(`c${this.seq}`, payload);
  }

  /** One received message → the whole frame to handle, or null when there is none yet
   *  (the other end's hello, or a chunk of a frame still arriving). */
  incoming(text: string): string | null {
    let raw: unknown;
    try {
      raw = JSON.parse(text);
    } catch {
      return text; // not ours to judge; the receiver decides what to do with it
    }
    if (isLinkHello(raw)) {
      this.peerJoins = true;
      return null;
    }
    const chunk = parseChunk(raw);
    return chunk === null ? text : this.joiner.accept(chunk);
  }
}
