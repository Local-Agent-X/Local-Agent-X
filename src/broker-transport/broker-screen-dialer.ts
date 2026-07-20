// BrokerScreenDialer — drives a live-screen ScreenSession over the broker rendezvous. It is
// the ADAPTER between two worlds:
//
//   broker world (vendor/): BrokerClient over a SocketAdapter, frames are RtcSignal
//     (offer/answer/ice) + lifecycle (joined/peer-present/peer-left/error/ice-servers)
//   session world (screen-stream/): ScreenSession folds RtcInboundFrame and emits
//     RtcOutboundFrame; it owns ffmpeg capture + the werift peer and is transport-blind
//
// The screen payload over the shared BrokerDialer lifecycle (docs/integration-lax-mobile.md):
//   onStart        → synthesize rtc_start (begin capture + offer on the session)
//   onAnswer/ice   → session.handleFrame rtc_answer / rtc_ice
//   session→rtc_offer / rtc_ice          → sendOffer / sendIce
//   session→displays/focus/error/closed  → ControlChannel (NOT the broker — §3.4)
//   onRebuild      → session.handleDisconnect (KEEP the socket)
//   onTeardown     → disconnect the session + close the control/chat/http channels
//
// Desktop = OFFERER. Adds NO new WebRTC behavior; it only re-homes where the existing
// offer/answer/ice are exchanged.

import { randomUUID } from "node:crypto";
import type { SocketAdapter } from "./vendor/socket-adapter.js";
import { BrokerDialer, type RemoteIceCandidate } from "./broker-dialer.js";
import type { ControlChannel } from "./control-channel.js";
import { NullChatChannel, type ChatChannel } from "./chat-bridge.js";
import { NullHttpChannel, type HttpChannel } from "./http-tunnel-bridge.js";
import { ScreenSession } from "../screen-stream/session.js";
import type { ScreenSessionOptions } from "../screen-stream/session.js";
import type { RtcOutboundFrame } from "../screen-stream/protocol.js";

/** The subset of ScreenSession the dialer drives — lets tests inject a fake session that
 *  records actions instead of spawning ffmpeg + werift. */
export interface ScreenSessionLike {
  handleFrame(frame: import("../screen-stream/protocol.js").RtcInboundFrame): void;
  handleDisconnect(): void;
  /** Start ffmpeg capture on the already-connected persistent peer (phone opened the live
   *  view). No-op on the tailnet path. */
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
  /** Read-only phone state projection on its own data channel. */
  projection?: ChatChannel;
  /** Builds the session. Defaults to the real ScreenSession; tests inject a fake. */
  createSession?: (opts: ScreenSessionOptions) => ScreenSessionLike;
  /** Fires ONCE when this dialer goes terminal — the presence supervisor schedules a
   *  reconnect. A dialer is single-use: after this, build a new one. */
  onClosed?: () => void;
}

export class BrokerScreenDialer extends BrokerDialer {
  private readonly control: ControlChannel;
  private readonly chat: ChatChannel;
  private readonly http: HttpChannel;
  private readonly projection: ChatChannel;
  private readonly session: ScreenSessionLike;
  /** One synthetic session correlation id — the broker has no rtcId (the rendezvous IS the
   *  session), so the dialer mints one for the ScreenSession side. */
  private readonly rtcId = randomUUID();

  constructor(deps: BrokerScreenDialerDeps) {
    super({ onClosed: deps.onClosed });
    this.control = deps.control;
    this.chat = deps.chat ?? new NullChatChannel();
    this.http = deps.http ?? new NullHttpChannel();
    this.projection = deps.projection ?? new NullChatChannel();

    const sessionOpts: ScreenSessionOptions = {
      send: (frame) => this.onSessionFrame(frame),
      getIceServers: () => this.iceServers,
      // The peer surfaces its control / chat / http data channels once they open; hand each
      // to its bridge so buffered + future frames flow over it.
      onControlTransport: (transport) => this.control.attach(transport),
      onChatTransport: (transport) => this.chat.attach(transport),
      onHttpTransport: (transport) => this.http.attach(transport),
      onProjectionTransport: (transport) => this.projection.attach(transport),
      // Broker peer is PERSISTENT (carries chat): establish it on present, but defer ffmpeg
      // until the phone opens the live view (openScreen, below).
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

    this.wireBroker(deps.socket);
  }

  /** Synthesize the rtc_start the desktop used to react to (begin capture + offer). */
  protected onStart(): void {
    this.session.handleFrame({ type: "rtc_start", rtcId: this.rtcId });
  }

  protected onAnswer(sdp: string): void {
    this.session.handleFrame({ type: "rtc_answer", rtcId: this.rtcId, sdp });
  }

  protected onRemoteIce(candidate: RemoteIceCandidate): void {
    this.session.handleFrame({ type: "rtc_ice", rtcId: this.rtcId, candidate });
  }

  /** The stale chat data channel closes here, so the ChatBridge detaches + re-attaches on
   *  the rebuilt peer. */
  protected onRebuild(): void {
    this.session.handleDisconnect();
  }

  protected onTeardown(): void {
    this.session.handleDisconnect();
    this.control.close();
    this.chat.close();
    this.http.close();
    this.projection.close();
  }

  // ── outbound: session → broker / control ─────────────────────────────────────────
  private onSessionFrame(frame: RtcOutboundFrame): void {
    if (this.stopped) return;
    switch (frame.type) {
      case "rtc_offer":
        this.sendOffer(frame.sdp);
        break;
      case "rtc_ice":
        this.sendIce(frame.candidate);
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
}
