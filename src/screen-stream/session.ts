// Live-screen session manager — the effect interpreter that wires the pure
// signaling machine (signaling-machine.ts) to the real ffmpeg capture
// (ffmpeg-capture.ts) and the werift peer (peer.ts), and pushes outbound
// signaling frames back over the chat socket.
//
// One session per paired connection. The chat-ws router (screen-stream-handler.ts)
// owns one of these per WS and forwards rtc_* frames + the disconnect signal into
// dispatch(); everything else (start capture → offer → answer/ICE → live →
// teardown) is driven by the machine's effects here. No I/O lives in the machine,
// so the ordering stays unit-testable while this glue stays thin.

import {
  signalingReducer,
  initialSignaling,
  type SignalingAction,
  type SignalingEffect,
  type SignalingMachine,
} from "./signaling-machine.js";
import { ScreenPeer, type IceServerConfig, type ControlTransport } from "./peer.js";
import { startCapture, type CaptureHandle } from "./ffmpeg-capture.js";
import {
  buildOffer,
  buildIce,
  buildError,
  buildClosed,
  buildDisplays,
  buildFocus,
  type RtcInboundFrame,
  type RtcIceCandidate,
  type RtcOutboundFrame,
} from "./protocol.js";
import { ScreenInputController, describeDisplays } from "./screen-input.js";
import { queryEditableFocus } from "./focus-watch.js";
import { createLogger } from "../logger.js";

const logger = createLogger("screen-stream.session");

/** Delay after a click/key before probing focus — lets the injected event land
 *  and the target app move focus before we ask the OS what's focused. */
const FOCUS_PROBE_DELAY_MS = 180;

/** Sends an outbound signaling frame to the phone over the chat socket. */
export type SendFrame = (frame: RtcOutboundFrame) => void;

/** A loopback UDP port allocator for the ffmpeg → peer RTP hop (overridable for tests). */
export type AllocateRtpPort = () => number;

/** Default allocator: a high ephemeral port; collisions are retried by the OS bind. */
function defaultAllocatePort(): number {
  return 41000 + Math.floor(Math.random() * 20000);
}

export interface ScreenSessionOptions {
  send: SendFrame;
  allocatePort?: AllocateRtpPort;
  /** Supplies the ICE servers for the peer at construction time. The broker transport
   *  returns the broker-minted STUN+TURN list (which arrives just before capture
   *  starts); the tailnet path omits this, so the peer keeps its env-STUN behavior.
   *  A getter (not a value) because the minted list lands after the session is built. */
  getIceServers?: () => IceServerConfig[];
  /** Broker transport only: opt into a control data channel. When set, the peer opens
   *  one (input + display/focus hints flow over it instead of /ws/chat) and surfaces a
   *  ControlTransport here once it's open. The tailnet path omits this — no data
   *  channel is created and control rides /ws/chat unchanged. */
  onControlTransport?: (transport: ControlTransport) => void;
  /** Broker transport only: opt into a `chat` data channel on the SAME peer (so the one
   *  broker connection multiplexes screen + chat). Surfaces its transport once open; the
   *  dialer bridges it to the desktop's own /ws/chat. Omitted on the tailnet path. */
  onChatTransport?: (transport: ControlTransport) => void;
  /** Broker transport only: opt into an `http` data channel on the same peer (device REST
   *  — app list / sessions / settings — tunneled to the desktop's loopback). Omitted on
   *  the tailnet path. */
  onHttpTransport?: (transport: ControlTransport) => void;
  /** Broker transport only: when true, `rtc_start` ESTABLISHES the peer (track + data
   *  channels + offer) but does NOT start ffmpeg — the persistent broker peer carries
   *  chat without the screen running. ffmpeg starts later via openScreen() when the
   *  phone opens the live view. Default false = tailnet behavior (establish + capture
   *  together on rtc_start), unchanged. */
  deferCapture?: boolean;
}

export class ScreenSession {
  private state: SignalingMachine = initialSignaling;
  private peer: ScreenPeer | null = null;
  private capture: CaptureHandle | null = null;
  /** Remote-control injector — exists only while a session is live. */
  private input: ScreenInputController | null = null;
  /** Debounced focus probe + last reported editable state (deduped to the phone). */
  private focusTimer: ReturnType<typeof setTimeout> | null = null;
  private lastEditable = false;
  /** Local ICE candidates produced before we're ready to flush (rare ordering). */
  private pendingLocalIce: RtcIceCandidate[] = [];
  /** Remote ICE candidates buffered until the peer exists / answer applied. */
  private pendingRemoteIce: RtcIceCandidate[] = [];
  private readonly allocatePort: AllocateRtpPort;
  /** Broker only: don't start ffmpeg on rtc_start (the persistent peer carries chat). */
  private readonly deferCapture: boolean;

  constructor(private readonly opts: ScreenSessionOptions) {
    this.allocatePort = opts.allocatePort ?? defaultAllocatePort;
    this.deferCapture = opts.deferCapture ?? false;
  }

  /** Phone opened the live view on an already-connected broker peer → start ffmpeg on
   *  the existing (silent) video track. No re-negotiation: the track was negotiated when
   *  the peer came up. No-op on the tailnet path (capture already running) or before the
   *  peer exists. */
  async openScreen(monitor?: number): Promise<void> {
    if (!this.peer || this.capture) return;
    await this.beginCapture(this.state.rtcId ?? "", monitor);
  }

  /** Phone closed the live view → stop ffmpeg but KEEP the peer (chat keeps flowing). */
  closeScreen(): void {
    this.endCapture();
  }

  /** Current lifecycle status (for diagnostics / the router log). */
  get status(): SignalingMachine["status"] {
    return this.state.status;
  }

  /** Fold a control/lifecycle action and run the resulting effects. */
  private apply(action: SignalingAction): void {
    const { state, effects } = signalingReducer(this.state, action);
    this.state = state;
    for (const effect of effects) void this.runEffect(effect);
  }

  /** Route a parsed inbound rtc_* frame from the phone. */
  handleFrame(frame: RtcInboundFrame): void {
    switch (frame.type) {
      case "rtc_start":
        this.apply({ kind: "start", rtcId: frame.rtcId });
        break;
      case "rtc_answer":
        this.apply({ kind: "answer", rtcId: frame.rtcId, sdp: frame.sdp });
        break;
      case "rtc_ice":
        // Buffer the candidate, then signal the machine (it gates by state).
        this.pendingRemoteIce.push(frame.candidate);
        this.apply({ kind: "remoteIce", rtcId: frame.rtcId });
        break;
      case "rtc_stop":
        this.apply({ kind: "stop", rtcId: frame.rtcId });
        break;
      case "rtc_input":
        // Drop input that arrives before/after a live session — no injector, no-op.
        this.input?.enqueue(frame.event);
        // A click or focus-moving key can change which element is focused; probe
        // shortly after so we can tell the phone to raise/dismiss its keyboard.
        if (this.input && (frame.event.kind === "click" || frame.event.kind === "key")) {
          this.scheduleFocusProbe(frame.rtcId);
        }
        break;
      default: {
        const _exhaustive: never = frame;
        break;
      }
    }
  }

  /** The WS dropped (disconnect or device revoke) — tear any session down. */
  handleDisconnect(): void {
    this.apply({ kind: "disconnect" });
  }

  /** Debounced focus probe: after the click/key settles, ask the OS whether a
   *  text field is focused and, only on a change, tell the phone (rtc_focus). */
  private scheduleFocusProbe(rtcId: string): void {
    if (this.focusTimer) clearTimeout(this.focusTimer);
    this.focusTimer = setTimeout(() => {
      this.focusTimer = null;
      void this.probeFocus(rtcId);
    }, FOCUS_PROBE_DELAY_MS);
  }

  private async probeFocus(rtcId: string): Promise<void> {
    if (!this.input) return; // session ended between schedule and fire
    const editable = await queryEditableFocus();
    if (!this.input || editable === this.lastEditable) return; // ended, or no change
    this.lastEditable = editable;
    this.opts.send(buildFocus(rtcId, editable));
  }

  private async runEffect(effect: SignalingEffect): Promise<void> {
    switch (effect.kind) {
      case "startCapture":
        await this.establishPeerAndOffer(effect.rtcId, effect.monitor);
        break;
      case "sendOffer":
        this.opts.send(buildOffer(effect.rtcId, effect.sdp));
        this.flushPendingLocalIce(effect.rtcId);
        break;
      case "applyAnswer":
        await this.applyAnswer(effect.rtcId, effect.sdp);
        break;
      case "applyRemoteIce":
        await this.applyRemoteIce();
        break;
      case "flushLocalIce":
        this.flushPendingLocalIce(effect.rtcId);
        break;
      case "teardown":
        await this.teardown();
        break;
      case "notifyClosed":
        this.opts.send(buildClosed(effect.rtcId, effect.reason));
        break;
      case "notifyError":
        this.opts.send(buildError(effect.rtcId, effect.message));
        break;
      default: {
        const _exhaustive: never = effect;
        break;
      }
    }
  }

  private async establishPeerAndOffer(rtcId: string, monitor?: number): Promise<void> {
    try {
      // The broker peer multiplexes screen + chat + http over ONE connection: open the
      // `chat` and `http` channels alongside `control` when the dialer wants them.
      const extra: Array<{ label: string; onReady: (t: ControlTransport) => void }> = [];
      if (this.opts.onChatTransport) extra.push({ label: "chat", onReady: this.opts.onChatTransport });
      if (this.opts.onHttpTransport) extra.push({ label: "http", onReady: this.opts.onHttpTransport });
      const extraChannels = extra.length > 0 ? extra : undefined;
      const peer = await ScreenPeer.create(
        {
          onLocalIce: (candidate) => {
            if (candidate === null) return; // end-of-candidates; nothing to trickle
            this.pendingLocalIce.push(candidate);
            this.apply({ kind: "localIce", rtcId });
          },
          onConnectionState: (connection) => {
            this.apply({ kind: "peerState", rtcId, connection });
          },
        },
        this.opts.getIceServers?.(),
        this.opts.onControlTransport,
        extraChannels,
      );
      this.peer = peer;

      // Tailnet (deferCapture=false): start ffmpeg now, exactly as before. Broker
      // (deferCapture=true): defer until the phone opens the live view (openScreen), so
      // the persistent peer carries chat without the screen running.
      if (!this.deferCapture) await this.beginCapture(rtcId, monitor);

      const sdp = await peer.createOffer();
      this.apply({ kind: "offerReady", rtcId, sdp });
    } catch (e) {
      this.apply({ kind: "fail", rtcId, message: `Couldn't start live screen: ${(e as Error).message}` });
    }
  }

  /** Start ffmpeg capture on the (already-built) peer, arm remote control, and tell the
   *  phone the monitor layout. Idempotent — a second call while capturing is a no-op. */
  private async beginCapture(rtcId: string, monitor?: number): Promise<void> {
    if (this.capture || !this.peer) return;
    const peer = this.peer;

    const rtpPort = this.allocatePort();
    this.capture = startCapture(
      { monitor, rtpPort },
      (packet) => peer.writeRtp(packet),
      (message) => this.apply({ kind: "fail", rtcId, message }),
    );

    // Arm remote control for this session + tell the phone how many monitors
    // exist (so it offers swipe-between-screens only when there's more than one).
    this.input = new ScreenInputController(monitor, (message) =>
      this.opts.send(buildError(rtcId, message)),
    );
    const d = await describeDisplays(monitor);
    this.opts.send(buildDisplays(rtcId, d.count, d.active, d.width, d.height));
  }

  /** Stop ffmpeg + remote control but LEAVE the peer intact (broker: chat keeps flowing
   *  after the live view closes). Idempotent. */
  private endCapture(): void {
    try {
      this.capture?.stop();
    } catch {
      /* already stopped */
    }
    this.capture = null;
    this.input = null;
    if (this.focusTimer) {
      clearTimeout(this.focusTimer);
      this.focusTimer = null;
    }
    this.lastEditable = false;
  }

  private async applyAnswer(rtcId: string, sdp: string): Promise<void> {
    if (!this.peer) return;
    try {
      await this.peer.applyAnswer(sdp);
      await this.applyRemoteIce(); // drain any ICE that arrived before the answer
    } catch (e) {
      this.apply({ kind: "fail", rtcId, message: `Live-screen negotiation failed: ${(e as Error).message}` });
    }
  }

  private async applyRemoteIce(): Promise<void> {
    if (!this.peer) return;
    const pending = this.pendingRemoteIce;
    this.pendingRemoteIce = [];
    for (const candidate of pending) {
      try {
        await this.peer.addRemoteIce(candidate);
      } catch (e) {
        logger.warn(`[screen-stream] addRemoteIce failed: ${(e as Error).message}`);
      }
    }
  }

  private flushPendingLocalIce(rtcId: string): void {
    const pending = this.pendingLocalIce;
    this.pendingLocalIce = [];
    for (const candidate of pending) this.opts.send(buildIce(rtcId, candidate));
  }

  private async teardown(): Promise<void> {
    this.endCapture();
    const peer = this.peer;
    this.peer = null;
    this.pendingLocalIce = [];
    this.pendingRemoteIce = [];
    if (peer) await peer.close();
  }
}
