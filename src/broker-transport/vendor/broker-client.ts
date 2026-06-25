// VENDORED from agentxos/packages/client/src/broker-client.ts — DO NOT HAND-EDIT.
// Re-sync on a protocol bump. Only change vs. upstream: the import paths (./*.js and
// ./protocol.js instead of @agentxos/protocol).
//
// BrokerClient — the shared, transport-agnostic broker SIGNALING client. It REPLACES
// the tailnet /ws/chat rtc_* signaling: instead of passing offer/answer/ICE over the
// chat socket, each side pumps them through this client, which wraps them in the
// broker's ClientFrame/ServerFrame contract and drives the gated rendezvous lifecycle.
//
// It is a PURE state machine over two injected seams — a SocketAdapter (already
// connected to the broker connect URL) and a set of RTC hooks — so it carries NO real
// WebSocket / RTCPeerConnection types. It does NOT open the socket or speak WebRTC; it
// routes frames and tells the host app what to do via hooks.
//
// Lifecycle: connecting → joined → peer-present → closed | error
// Gate/auth errors and the broker's 4401/4403 closes are TERMINAL and surfaced via
// onError — never a silent hang (constitution §16).

import type { BrokerErrorCode, IceServer, RtcSignal, ServerFrame } from "./protocol.js";
import { parseServerFrame } from "./parse-server-frame.js";
import { serializeClientFrame, type SocketAdapter } from "./socket-adapter.js";

/** Observable lifecycle state. A string-literal union (not an enum). */
export type BrokerClientState = "connecting" | "joined" | "peer-present" | "closed" | "error";

/** The broker WebSocket close codes the client treats as terminal gate/auth
 *  failures. Mirrors workers/broker/src/worker.ts (4401 unauthorized, 4403 gate
 *  denied). Any other close (1000, 1006, …) is a transport drop, not a refusal. */
export const CLOSE_UNAUTHORIZED = 4401;
export const CLOSE_GATE_DENIED = 4403;

/** Hooks the host app's WebRTC layer supplies. Every one is optional so a minimal
 *  consumer can subscribe to only what it needs; BrokerClient never assumes a hook
 *  exists. These are the seam the existing peer.ts / session.ts code plugs into. */
export interface BrokerClientHooks {
  /** Deliver a received offer/answer/ICE to the local RTCPeerConnection. This is
   *  the inbound half of what the old rtc_offer/rtc_answer/rtc_ice frames did. */
  onSignal?(signal: RtcSignal): void;
  /** Apply the broker-minted ICE config (STUN + short-lived TURN) to the peer
   *  connection. `ttlSeconds` is when the TURN credential expires (re-dial after). */
  onIceServers?(iceServers: IceServer[], ttlSeconds: number): void;
  /** The peer (the other device) is now present in the rendezvous — the offerer
   *  can begin negotiation. Fires on `joined{peerPresent:true}` or `peer-joined`. */
  onPeerPresent?(): void;
  /** The peer left the rendezvous (its socket dropped). Tear down the live session. */
  onPeerLeft?(): void;
  /** An actionable gate/auth/transport error. `code` is the broker's BrokerErrorCode
   *  or a synthetic code for a terminal close; `message` is user-facing copy (§16). */
  onError?(code: BrokerErrorCode, message: string): void;
  /** Optional observability: every state transition. */
  onStateChange?(state: BrokerClientState): void;
}

/** Synthetic error code for a terminal close that carried no `error` frame (e.g. a
 *  bare 4403). Reuses the protocol's coarse codes so consumers match one set. */
const CLOSE_CODE_FOR: Record<number, BrokerErrorCode> = {
  [CLOSE_UNAUTHORIZED]: "unauthorized",
  [CLOSE_GATE_DENIED]: "bad_request",
};

export class BrokerClient {
  private state: BrokerClientState = "connecting";
  private readonly socket: SocketAdapter;
  private readonly hooks: BrokerClientHooks;
  /** Latches once we reach a terminal state so a trailing close/frame can't
   *  re-fire onError or move the machine backwards. */
  private terminal = false;

  constructor(socket: SocketAdapter, hooks: BrokerClientHooks = {}) {
    this.socket = socket;
    this.hooks = hooks;
    this.socket.onMessage((data) => this.handleMessage(data));
    this.socket.onClose((code, reason) => this.handleClose(code, reason));
  }

  /** Current lifecycle state (for the host UI / diagnostics). */
  get currentState(): BrokerClientState {
    return this.state;
  }

  /** Wrap a local offer/answer/ICE in a ClientFrame and send it to the broker,
   *  which relays it verbatim to the peer. No-op once terminal. */
  sendSignal(signal: RtcSignal): void {
    if (this.terminal) return;
    this.socket.send(serializeClientFrame({ type: "signal", signal }));
  }

  /** Stop the session locally (user closed the live view). Terminal + idempotent. */
  stop(): void {
    if (this.terminal) return;
    this.transition("closed");
    this.terminal = true;
    this.socket.close("client-stop");
  }

  private handleMessage(data: string): void {
    if (this.terminal) return;
    let raw: unknown;
    try {
      raw = JSON.parse(data);
    } catch {
      return; // ignore non-JSON noise; the broker only ever sends valid frames
    }
    const frame = parseServerFrame(raw);
    if (!frame) return; // malformed/unknown frame — drop, don't crash the client
    this.dispatch(frame);
  }

  private dispatch(frame: ServerFrame): void {
    switch (frame.type) {
      case "joined":
        this.transition("joined");
        if (frame.peerPresent) this.peerPresent();
        break;
      case "peer-joined":
        this.peerPresent();
        break;
      case "peer-left":
        if (this.state === "peer-present") this.transition("joined");
        this.hooks.onPeerLeft?.();
        break;
      case "signal":
        this.hooks.onSignal?.(frame.signal);
        break;
      case "ice-servers":
        this.hooks.onIceServers?.(frame.iceServers, frame.ttlSeconds);
        break;
      case "error":
        this.fail(frame.code, frame.message);
        break;
      default: {
        const _exhaustive: never = frame;
        break;
      }
    }
  }

  private peerPresent(): void {
    if (this.state === "peer-present") return; // idempotent (joined+present then peer-joined)
    this.transition("peer-present");
    this.hooks.onPeerPresent?.();
  }

  private handleClose(code: number, reason: string): void {
    if (this.terminal) return;
    const errorCode = CLOSE_CODE_FOR[code];
    if (errorCode) {
      // A gate/auth close (4401/4403) with no preceding error frame — surface it as
      // a terminal error so the UI never silently stalls (constitution §16).
      this.fail(errorCode, reason || closeMessage(code));
      return;
    }
    // A normal/transport close. If we never errored, this is an ordinary teardown.
    this.transition("closed");
    this.terminal = true;
  }

  /** Move to the error state, fire onError once, and latch terminal. Gate/auth
   *  errors are terminal by contract — there is no retry on the same socket. */
  private fail(code: BrokerErrorCode, message: string): void {
    if (this.terminal) return;
    this.terminal = true;
    this.transition("error");
    this.hooks.onError?.(code, message);
    this.socket.close("error");
  }

  private transition(next: BrokerClientState): void {
    if (this.state === next) return;
    this.state = next;
    this.hooks.onStateChange?.(next);
  }
}

/** Default user-facing copy for a terminal close with no broker `error` frame. */
function closeMessage(code: number): string {
  if (code === CLOSE_UNAUTHORIZED) {
    return "Authentication failed. Sign in on agentxos and try again.";
  }
  if (code === CLOSE_GATE_DENIED) {
    return "The broker refused the connection. Check your subscription and that this phone is paired to the desktop.";
  }
  return "The connection to the broker closed.";
}
