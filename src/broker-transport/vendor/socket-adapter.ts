// VENDORED from agentxos/packages/client/src/socket-adapter.ts — DO NOT HAND-EDIT.
// Re-sync on a protocol bump. Only change vs. upstream: the protocol import path.
//
// The injected socket seam. BrokerClient is transport-agnostic: it never imports a
// real WebSocket (browser), `ws` (Node), or react-native's WebSocket — each repo
// wraps ITS socket in this tiny adapter and hands it in. The desktop's concrete
// `ws`-backed implementation lives in ../ws-socket-adapter.ts.
//
// Lifecycle the adapter owns: the caller has ALREADY opened the socket to the connect
// URL (see buildConnectUrl) before constructing BrokerClient. The adapter then routes
// inbound text frames into onMessage and the socket close into onClose, and lets
// BrokerClient push outbound text via send() / hang up via close().

import type { ClientFrame } from "./protocol.js";

/** Why the local side is closing the socket (passed to close()). Informational —
 *  the broker's gate close codes (4401/4403) arrive the OTHER way, via onClose. */
export type CloseReason = "client-stop" | "error";

export interface SocketAdapter {
  /** Send one serialized frame to the broker. The caller serializes via the
   *  client (sendSignal builds a ClientFrame); the adapter just writes the text. */
  send(text: string): void;
  /** Close the underlying socket. Idempotent; safe to call after a remote close. */
  close(reason: CloseReason): void;
  /** Register the inbound-text handler. `data` is the raw frame string off the wire
   *  (BrokerClient JSON-parses + validates it). Called once by BrokerClient at wire-up. */
  onMessage(handler: (data: string) => void): void;
  /** Register the socket-close handler. `code` is the WebSocket close code (the
   *  broker uses 4401 unauthorized / 4403 gate-denied); `reason` is its text. */
  onClose(handler: (code: number, reason: string) => void): void;
}

/** Serialize a ClientFrame for the adapter. Single construction point so the wire
 *  shape is produced one way (mirrors the broker's JSON.stringify of ServerFrames). */
export function serializeClientFrame(frame: ClientFrame): string {
  return JSON.stringify(frame);
}
