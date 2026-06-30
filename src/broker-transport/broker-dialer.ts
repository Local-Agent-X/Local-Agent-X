// BrokerDialer — the shared desktop-side rendezvous lifecycle that BrokerScreenDialer and
// BrokerVoiceDialer both drive. It owns the broker state machine that is IDENTICAL across
// the two: wait for the phone to be present AND ICE config (or a grace window) → start;
// route inbound answer/ice signals; ignore an inbound offer (the desktop is the offerer);
// rebuild on peer-left while KEEPING the socket; tear down on socket-close / error / stop.
//
// It deliberately shares CODE, not STATE: each subclass is its own instance with its own
// BrokerClient / socket / peer, so the voice and screen connections stay fully independent
// — a drop on one never touches the other. Subclasses fill in only the payload: what to do
// on start (build a peer + offer, or synthesize a session start), how to apply an inbound
// answer / ice, what to drop on rebuild, and what to close on teardown.

import { BrokerClient } from "./vendor/broker-client.js";
import type { IceServer, RtcSignal } from "./vendor/protocol.js";
import type { SocketAdapter } from "./vendor/socket-adapter.js";
import { iceSignal, type DialerIceCandidate } from "./ice-signal.js";
import { createLogger } from "../logger.js";

const logger = createLogger("broker-transport.dialer");

/** How long to wait after `peer-present` for the broker's `ice-servers` frame before
 *  starting anyway. A TURN-configured broker mints + sends ice-servers once both peers are
 *  present, so it normally arrives first; a TURN-less broker never sends it, so we must not
 *  wait forever (that would be a silent hang). */
export const ICE_GRACE_MS = 2000;

/** An inbound remote ICE candidate, normalized from the broker's ice signal — the shape
 *  both the voice peer and the screen session consume. */
export interface RemoteIceCandidate {
  candidate: string;
  sdpMid: string | null;
  sdpMLineIndex: number | null;
}

export interface BrokerDialerOptions {
  /** Fires ONCE when this dialer goes terminal (socket close, error, or stop) — the
   *  presence supervisor uses it to schedule a reconnect. A dialer is single-use. */
  onClosed?: () => void;
  /** Disambiguates log lines between the voice and screen dialers (e.g. "voice "). */
  logLabel?: string;
}

export abstract class BrokerDialer {
  private client!: BrokerClient;
  private readonly onClosedCb: (() => void) | undefined;
  private readonly logLabel: string;

  /** Latest broker-minted ICE config — readable by subclasses when they start the peer. */
  protected iceServers: IceServer[] = [];
  /** True once a terminal teardown has run; subclass hooks read it to drop late work. */
  protected stopped = false;

  private peerPresent = false;
  private started = false;
  private graceTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(opts: BrokerDialerOptions = {}) {
    this.onClosedCb = opts.onClosed;
    this.logLabel = opts.logLabel ?? "";
  }

  /** Wire the broker socket. Subclasses MUST call this LAST in their constructor, after
   *  their payload (peer / session / channels) is built — so a socket event never fires
   *  into a half-constructed subclass. */
  protected wireBroker(socket: SocketAdapter): void {
    this.client = new BrokerClient(socket, {
      onPeerPresent: () => this.onPeerPresent(),
      onSignal: (signal) => this.onSignal(signal),
      onIceServers: (servers) => this.onIceServers(servers),
      // Phone left (or the broker re-fired our lifecycle on its reconnect): rebuild the
      // payload, KEEP the socket. A dropped OWN socket is onClosed → full teardown. The
      // broker evicts any stale slot so re-dials never role_taken.
      onPeerLeft: () => this.prepareRebuild(),
      onClosed: () => this.teardown(),
      onError: (code, message) => {
        // The phone receives its OWN broker error and surfaces actionable copy; on the
        // desktop we just tear down (no UI here). Gate / auth errors are terminal.
        logger.warn(`[broker-transport] ${this.logLabel}broker error (${code}): ${message}`);
        this.teardown();
      },
    });
  }

  /** Stop locally (presence shutdown / app exit). Idempotent. */
  stop(): void {
    this.teardown();
  }

  // ── outbound helpers for subclasses ──────────────────────────────────────────────

  protected sendOffer(sdp: string): void {
    if (!this.stopped) this.client.sendSignal({ kind: "offer", sdp });
  }

  protected sendIce(candidate: DialerIceCandidate): void {
    if (!this.stopped) this.client.sendSignal(iceSignal(candidate));
  }

  // ── shared inbound lifecycle ─────────────────────────────────────────────────────

  private onPeerPresent(): void {
    this.peerPresent = true;
    this.maybeStart();
    // Arm a fallback so a TURN-less broker (no ice-servers frame) still starts.
    if (!this.started && this.graceTimer === null) {
      this.graceTimer = setTimeout(() => {
        this.graceTimer = null;
        logger.warn(`[broker-transport] ${this.logLabel}no ice-servers within ${ICE_GRACE_MS}ms — STUN/host-only`);
        this.maybeStart(true);
      }, ICE_GRACE_MS);
    }
  }

  private onIceServers(servers: IceServer[]): void {
    this.iceServers = servers;
    this.maybeStart();
  }

  /** Start once the phone is present AND we have ICE (or the grace window elapsed).
   *  Synchronous on purpose: a synchronous onStart (the screen path) must take effect
   *  within the delivering call. An async onStart (the voice peer build) runs detached,
   *  with its failure routed to teardown. */
  private maybeStart(force = false): void {
    if (this.started || this.stopped || !this.peerPresent) return;
    if (this.iceServers.length === 0 && !force) return;
    this.started = true;
    this.clearGrace();
    try {
      const result = this.onStart();
      if (result) result.catch((e: unknown) => this.failStart(e));
    } catch (e) {
      this.failStart(e);
    }
  }

  private failStart(e: unknown): void {
    logger.error(`[broker-transport] ${this.logLabel}start failed: ${(e as Error).message}`);
    this.teardown();
  }

  private onSignal(signal: RtcSignal): void {
    if (this.stopped) return;
    switch (signal.kind) {
      case "answer":
        this.onAnswer(signal.sdp);
        break;
      case "ice":
        this.onRemoteIce({ candidate: signal.candidate, sdpMid: signal.sdpMid, sdpMLineIndex: signal.sdpMLineIndex });
        break;
      case "offer":
        // Desktop is the offerer; an inbound offer is a protocol error — ignore it rather
        // than answering our own role.
        logger.warn(`[broker-transport] ${this.logLabel}ignoring unexpected inbound offer (desktop is the offerer)`);
        break;
      default: {
        const _exhaustive: never = signal;
        break;
      }
    }
  }

  /** Phone left the rendezvous (genuinely left, or reconnected → the broker re-fired our
   *  lifecycle): drop the stale payload + reset so the following peer-present rebuilds on
   *  the re-minted ICE. KEEP the socket (a dropped socket is the separate teardown path). */
  private prepareRebuild(): void {
    if (this.stopped || !this.started) return;
    this.onRebuild();
    this.started = false;
    this.iceServers = []; // the broker's re-mint refills this before we rebuild
  }

  protected teardown(): void {
    if (this.stopped) return;
    this.stopped = true;
    this.clearGrace();
    // Close the broker rendezvous socket on EVERY terminal path. Otherwise the broker keeps
    // holding this desktop's slot and the presence supervisor's reconnect loops forever on
    // `role_taken`. client.stop() is idempotent, so a path where it already closed is safe.
    this.client.stop();
    this.onTeardown();
    this.onClosedCb?.();
  }

  private clearGrace(): void {
    if (this.graceTimer !== null) {
      clearTimeout(this.graceTimer);
      this.graceTimer = null;
    }
  }

  // ── payload hooks the subclass fills in ──────────────────────────────────────────

  /** Begin the session: build the peer + send the offer (voice), or synthesize the session
   *  start (screen). Return a promise to have a failure routed to teardown. */
  protected abstract onStart(): void | Promise<void>;
  /** Apply an inbound SDP answer to the payload. */
  protected abstract onAnswer(sdp: string): void;
  /** Apply an inbound remote ICE candidate to the payload. */
  protected abstract onRemoteIce(candidate: RemoteIceCandidate): void;
  /** Drop the stale peer / session on a phone reconnect (the socket is kept). */
  protected abstract onRebuild(): void;
  /** Close the payload (peer / session + channels) on terminal teardown. */
  protected abstract onTeardown(): void;
}
