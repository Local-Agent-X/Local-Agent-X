/**
 * IPC framing — JSON-lines over stdio.
 *
 * Message format: one JSON object per line, terminated by \n. Lines that
 * don't parse as valid IPC envelopes are surfaced as warnings (typically
 * stray stdout from the worker process, not real IPC traffic).
 *
 * This module is dependency-free so both the supervisor side (parent) and
 * the worker side (child) can import it without pulling in heavy modules.
 *
 * Why JSON-lines and not a binary protocol: simplicity beats throughput
 * here. Worker→supervisor traffic is bounded by model speed (tokens/sec),
 * not bandwidth. JSON-lines is debuggable by `cat`, robust to partial
 * reads, and works identically on Windows and Unix.
 *
 * Versioning: every envelope carries protocolVersion (see types.ts). On
 * mismatch, the receiver may either translate (if compatible) or refuse
 * — the supervisor's policy is to recycle workers on mismatch (per §17).
 */

import { Readable, Writable } from "node:stream";
import { IPC_PROTOCOL_VERSION, type IpcMessage } from "./types.js";

// ── Send ───────────────────────────────────────────────────────────────────

/** Serialize and write a single IPC message followed by \n. Synchronous-write semantics. */
export function sendIpc(stream: Writable, msg: IpcMessage): void {
  // Single JSON.stringify; we don't pretty-print (size matters across IPC).
  // Embedded newlines in payload string fields are JSON-escaped so the line
  // boundary stays unambiguous.
  const line = JSON.stringify(msg) + "\n";
  stream.write(line);
}

// ── Receive ────────────────────────────────────────────────────────────────

export interface IpcReceiverOptions {
  /** Called with every successfully-parsed IPC message. */
  onMessage: (msg: IpcMessage) => void;
  /**
   * Called when a stdout line arrives that isn't valid IPC. Defaults to
   * forwarding the line to console.warn so worker stray-print doesn't
   * vanish silently. Pass a no-op to suppress.
   */
  onNonIpcLine?: (line: string) => void;
  /** Called on unrecoverable framing errors (oversized line, etc.). */
  onError?: (err: Error) => void;
  /** Hard cap on a single IPC line. Defaults to 16MB. */
  maxLineBytes?: number;
}

/**
 * Attach a line-decoding parser to a Readable. Returns a detach function.
 * Buffers across chunk boundaries; emits one onMessage call per complete
 * line. Lines > maxLineBytes drop the buffer and call onError.
 */
export function receiveIpc(stream: Readable, opts: IpcReceiverOptions): () => void {
  const maxLineBytes = opts.maxLineBytes ?? 16 * 1024 * 1024;
  const onNonIpcLine = opts.onNonIpcLine ?? ((line: string) => {
    process.stderr.write(`[ipc] non-IPC line: ${line.slice(0, 200)}\n`);
  });
  const onError = opts.onError ?? ((err: Error) => {
    process.stderr.write(`[ipc] error: ${err.message}\n`);
  });

  let buffer = "";
  let detached = false;

  const onData = (chunk: Buffer | string) => {
    if (detached) return;
    buffer += typeof chunk === "string" ? chunk : chunk.toString("utf-8");
    if (buffer.length > maxLineBytes) {
      onError(new Error(`line too long (>${maxLineBytes} bytes), dropping buffer`));
      buffer = "";
      return;
    }
    let idx;
    while ((idx = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, idx).replace(/\r$/, "");
      buffer = buffer.slice(idx + 1);
      if (!line.trim()) continue;
      processLine(line);
    }
  };

  const processLine = (line: string) => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      onNonIpcLine(line);
      return;
    }
    if (!isValidIpcEnvelope(parsed)) {
      onNonIpcLine(line);
      return;
    }
    if (parsed.protocolVersion !== IPC_PROTOCOL_VERSION) {
      onError(new Error(`protocol version mismatch: expected ${IPC_PROTOCOL_VERSION}, got ${parsed.protocolVersion}`));
      return;
    }
    opts.onMessage(parsed as IpcMessage);
  };

  stream.on("data", onData);
  stream.on("error", onError);

  return () => {
    detached = true;
    stream.off("data", onData);
    stream.off("error", onError);
  };
}

// ── Validation ─────────────────────────────────────────────────────────────

function isValidIpcEnvelope(obj: unknown): obj is { protocolVersion: number; type: string; messageId: string; ts: string; payload: unknown } {
  if (!obj || typeof obj !== "object") return false;
  const o = obj as Record<string, unknown>;
  return (
    typeof o.protocolVersion === "number" &&
    typeof o.type === "string" &&
    typeof o.messageId === "string" &&
    typeof o.ts === "string" &&
    typeof o.payload === "object" && o.payload !== null
  );
}
