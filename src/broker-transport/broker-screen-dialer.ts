// BrokerScreenDialer — the desktop glue that drives a live-screen ScreenSession from
// the broker rendezvous instead of the tailnet /ws/chat socket. It is the ADAPTER
// between two worlds:
//
//   broker world (vendor/): BrokerClient over a SocketAdapter, frames are RtcSignal
//     (offer/answer/ice) + lifecycle (joined/peer-present/peer-left/error/ice-servers)
//   session world (screen-stream/): ScreenSession folds RtcInboundFrame and emits
//     RtcOutboundFrame; it owns ffmpeg capture + the werift peer and is transport-blind
//
// The mapping (docs/integration-lax-mobile.md §2/§3):
//   onPeerPresent       → synthesize rtc_start (the new "begin capture + offer" trigger)
//   onSignal(answer)    → rtc_answer        onSignal(ice) → rtc_ice
//   session→rtc_offer   → sendSignal(offer) session→rtc_ice → sendSignal(ice)
//   session→displays/focus/error/closed → ControlChannel (NOT the broker — §3.4)
//   onIceServers        → captured + fed into the peer at construction (§4, via D3)
//   onPeerLeft / onError / stop → tear the session down
//
// Desktop = OFFERER (unchanged). This class adds NO new WebRTC behavior; it only
// re-homes where the existing offer/answer/ice are exchanged.

import { randomUUID } from "node:crypto";
import { BrokerClient } from "./vendor/broker-client.js";
import type { IceServer, RtcSignal } from "./vendor/protocol.js";
import type { SocketAdapter } from "./vendor/socket-adapter.js";
import type { ControlChannel } from "./control-channel.js";
import { NullChatChannel, type ChatChannel } from "./chat-bridge.js";
import { NullHttpChannel, type HttpChannel } from "./http-tunnel-bridge.js";
import { ScreenSession } from "../screen-stream/session.js";
import type { ScreenSessionOptions } from "../screen-stream/session.js";
import type { RtcIceCandidate, RtcOutboundFrame } from "../screen-stream/protocol.js";
import { createLogger } from "../logger.js";

const logger = createLogger("broker-transport.dialer");

/** How long to wait after `peer-present` for the broker's `ice-servers` frame before
 *  starting capture anyway. A TURN-configured broker mints + sends ice-servers once
 *  both peers are present, so it normally arrives first; a TURN-less broker never
 *  sends it, so we must not wait forever (that would be a silent hang). */
const ICE_GRACE_MS = 2000;

/** The subset of ScreenSession the dialer drives — lets tests inject a fake session
 *  that records actions instead of spawning ffmpeg + werift. */
export interface ScreenSessionLike {
  handleFrame(frame: import("../screen-stream/protocol.js").RtcInboundFrame): void;
  handleDisconnect(): void;
  /** Start ffmpeg capture on the already-connected persistent peer (phone opened the
   *  live view). No-op on the tailnet path. */
  openScreen(monitor?: number): void | Promise<void>;
  /** Stop ffmpeg but keep the peer (phone closed the live view; chat keeps flowing). */
  closeScreen(): void;
}

export interface BrokerScreenDialerDeps {
  /** A SocketAdapter already opening to the broker connect URL (openBrokerSocket). */
  socket: SocketAdapter;
  /** Where app control (input/displays/focus) flows — the data channel, eventually. */
  control: ControlChannel;
  /** Where chat flows: the peer's `chat` data channel, bridged to the desktop's own
   *  /ws/chat. Defaults to NullChatChannel (chat stays on the tailnet / not wired). */
  chat?: ChatChannel;
  /** Where device REST flows: the peer's `http` data channel, tunneled to the desktop's
   *  loopback (app list / sessions / settings). Defaults to NullHttpChannel. */
  http?: HttpChannel;
  /** Builds the session. Defaults to the real ScreenSession; tests inject a fake. */
  createSession?: (opts: ScreenSessionOptions) => ScreenSessionLike;
  /** Fires ONCE when this dialer goes terminal (peer left, error, or stop) — the
   *  presence supervisor uses it to schedule a reconnect. A dialer is single-use:
   *  after this, build a new one. */
  onClosed?: () => void;
}

export class BrokerScreenDialer {
  private readonly client: BrokerClient;
  private readonly control: ControlChannel;
  private readonly chat: ChatChannel;
  private readonly http: HttpChannel;
  private readonly session: ScreenSessionLike;
  private readonly onClosed: (() => void) | undefined;
  /** One synthetic session correlation id — the broker has no rtcId (the rendezvous
   *  IS the session), so the dialer mints one for the ScreenSession side. */
  private readonly rtcId = randomUUID();

  /** Latest broker-minted ICE config, fed into the peer when capture starts (D3). */
  private iceServers: IceServer[] = [];
  private peerPresent = false;
  private started = false;
  private stopped = false;
  private graceTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(deps: BrokerScreenDialerDeps) {
    this.control = deps.control;
    this.chat = deps.chat ?? new NullChatChannel();
    this.http = deps.http ?? new NullHttpChannel();
    this.onClosed = deps.onClosed;

    const sessionOpts: ScreenSessionOptions = {
      send: (frame) => this.onSessionFrame(frame),
      getIceServers: () => this.iceServers,
      // The peer surfaces its control data channel once it opens; hand it to the
      // ControlChannel so buffered + future control frames flow over it.
      onControlTransport: (transport) => this.control.attach(transport),
      // …its `chat` channel to the ChatBridge, and its `http` channel to the HttpTunnel.
      onChatTransport: (transport) => this.chat.attach(transport),
      onHttpTransport: (transport) => this.http.attach(transport),
      // Broker peer is PERSISTENT (carries chat): establish it on present, but defer
      // ffmpeg until the phone opens the live view (openScreen, below).
      deferCapture: true,
    };
    this.session = (deps.createSession ?? ((opts) => new ScreenSession(opts)))(sessionOpts);

    // Inbound remote control (once the data channel is wired) → drive the session.
    this.control.onInput((event) => {
      if (this.stopped) return;
      this.session.handleFrame({ type: "rtc_input", rtcId: this.rtcId, event });
    });

    // Phone opened/closed the live view → start/stop ffmpeg on the persistent peer.
    this.control.onScreenCommand((cmd) => {
      if (this.stopped) return;
      if (cmd.kind === "open") void this.session.openScreen(cmd.monitor);
      else this.session.closeScreen();
    });

    this.client = new BrokerClient(deps.socket, {
      onPeerPresent: () => this.onPeerPresent(),
      onSignal: (signal) => this.onSignal(signal),
      onIceServers: (servers) => this.onIceServers(servers),
      // Phone left the rendezvous (or reconnected → the broker re-fires our lifecycle):
      // rebuild our peer, KEEP our socket. A dropped OWN socket is a full teardown +
      // presence reconnect. The broker evicts any stale slot so re-dials never role_taken.
      onPeerLeft: () => this.prepareRebuild(),
      onClosed: () => this.teardown(),
      onError: (code, message) => {
        // The phone receives its OWN broker error and surfaces the actionable copy;
        // on the desktop we just tear down (no UI here). Gate/auth errors are terminal.
        logger.warn(`[broker-transport] broker error (${code}): ${message}`);
        this.teardown();
      },
    });
  }

  /** Stop the live session locally (user closed the view / app shutdown). Idempotent. */
  stop(): void {
    this.teardown();
  }

  // ── inbound: broker → session ────────────────────────────────────────────────

  private onPeerPresent(): void {
    this.peerPresent = true;
    this.maybeStart();
    // Arm a fallback so a TURN-less broker (no ice-servers frame) still starts.
    if (!this.started && this.graceTimer === null) {
      this.graceTimer = setTimeout(() => {
        this.graceTimer = null;
        logger.warn(`[broker-transport] no ice-servers within ${ICE_GRACE_MS}ms — starting STUN/host-only`);
        this.maybeStart(true);
      }, ICE_GRACE_MS);
    }
  }

  /** The phone LEFT the rendezvous (a peer-left frame) — either it genuinely left, or the
   *  broker re-fired our lifecycle because it RECONNECTED. Either way our session peer is
   *  stale: tear it down + reset so the following peer-joined (the phone returning)
   *  rebuilds it on the re-minted ICE — KEEPING our broker socket. (A dropped socket is a
   *  separate path: onClosed → full teardown + presence reconnect.) The stale chat data
   *  channel closes here, so the ChatBridge detaches + re-attaches on the rebuilt peer. */
  private prepareRebuild(): void {
    if (this.stopped || !this.started) return;
    this.session.handleDisconnect();
    this.started = false;
    this.iceServers = []; // the broker's re-mint refills this before we rebuild
  }

  private onIceServers(servers: IceServer[]): void {
    this.iceServers = servers;
    this.maybeStart();
  }

  /** Begin capture + offer once the peer is present AND we have ICE config (or the
   *  grace window elapsed). Synthesizes the rtc_start the desktop used to react to. */
  private maybeStart(force = false): void {
    if (this.started || this.stopped || !this.peerPresent) return;
    if (this.iceServers.length === 0 && !force) return; // wait for ice-servers (or grace)
    this.started = true;
    if (this.graceTimer !== null) {
      clearTimeout(this.graceTimer);
      this.graceTimer = null;
    }
    this.session.handleFrame({ type: "rtc_start", rtcId: this.rtcId });
  }

  private onSignal(signal: RtcSignal): void {
    if (this.stopped) return;
    switch (signal.kind) {
      case "answer":
        this.session.handleFrame({ type: "rtc_answer", rtcId: this.rtcId, sdp: signal.sdp });
        break;
      case "ice":
        this.session.handleFrame({
          type: "rtc_ice",
          rtcId: this.rtcId,
          candidate: { candidate: signal.candidate, sdpMid: signal.sdpMid, sdpMLineIndex: signal.sdpMLineIndex },
        });
        break;
      case "offer":
        // Desktop is the offerer; an inbound offer is a protocol error — ignore it
        // rather than answering our own role.
        logger.warn("[broker-transport] ignoring unexpected inbound offer (desktop is the offerer)");
        break;
      default: {
        const _exhaustive: never = signal;
        break;
      }
    }
  }

  // ── outbound: session → broker / control ─────────────────────────────────────

  private onSessionFrame(frame: RtcOutboundFrame): void {
    if (this.stopped) return;
    switch (frame.type) {
      case "rtc_offer":
        this.client.sendSignal({ kind: "offer", sdp: frame.sdp });
        break;
      case "rtc_ice":
        this.client.sendSignal(iceSignal(frame.candidate));
        break;
      case "rtc_displays":
      case "rtc_focus":
      case "rtc_error":
      case "rtc_closed":
        this.control.send(frame);
        break;
      default: {
        const _exhaustive: never = frame;
        break;
      }
    }
  }

  private teardown(): void {
    if (this.stopped) return;
    this.stopped = true;
    if (this.graceTimer !== null) {
      clearTimeout(this.graceTimer);
      this.graceTimer = null;
    }
    // Close the broker rendezvous socket on EVERY terminal path (peer-left, error, or an
    // explicit stop) — NOT just stop(). A peer-left would otherwise leave this desktop's
    // socket open, the broker keeps holding the 'desktop' slot, and the presence
    // supervisor's reconnect loops forever on `role_taken`. client.stop() is idempotent,
    // so a path where the client already closed (a gate/auth error) is a safe no-op.
    this.client.stop();
    this.session.handleDisconnect();
    this.control.close();
    this.chat.close();
    this.http.close();
    this.onClosed?.();
  }
}

/** Map a desktop ICE candidate to the broker's ice signal, coercing the optional
 *  sdpMid/sdpMLineIndex to the explicit `null` the wire contract requires (§2). */
function iceSignal(c: RtcIceCandidate): RtcSignal {
  return { kind: "ice", candidate: c.candidate, sdpMid: c.sdpMid ?? null, sdpMLineIndex: c.sdpMLineIndex ?? null };
}
