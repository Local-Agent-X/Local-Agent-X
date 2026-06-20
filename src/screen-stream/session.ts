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
import { ScreenPeer } from "./peer.js";
import { startCapture, type CaptureHandle } from "./ffmpeg-capture.js";
import {
  buildOffer,
  buildIce,
  buildError,
  buildClosed,
  buildDisplays,
  type RtcInboundFrame,
  type RtcIceCandidate,
  type RtcOutboundFrame,
} from "./protocol.js";
import { ScreenInputController, describeDisplays } from "./screen-input.js";
import { createLogger } from "../logger.js";

const logger = createLogger("screen-stream.session");

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
}

export class ScreenSession {
  private state: SignalingMachine = initialSignaling;
  private peer: ScreenPeer | null = null;
  private capture: CaptureHandle | null = null;
  /** Remote-control injector — exists only while a session is live. */
  private input: ScreenInputController | null = null;
  /** Local ICE candidates produced before we're ready to flush (rare ordering). */
  private pendingLocalIce: RtcIceCandidate[] = [];
  /** Remote ICE candidates buffered until the peer exists / answer applied. */
  private pendingRemoteIce: RtcIceCandidate[] = [];
  private readonly allocatePort: AllocateRtpPort;

  constructor(private readonly opts: ScreenSessionOptions) {
    this.allocatePort = opts.allocatePort ?? defaultAllocatePort;
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

  private async runEffect(effect: SignalingEffect): Promise<void> {
    switch (effect.kind) {
      case "startCapture":
        await this.startCaptureAndOffer(effect.rtcId, effect.monitor);
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

  private async startCaptureAndOffer(rtcId: string, monitor?: number): Promise<void> {
    try {
      const peer = await ScreenPeer.create({
        onLocalIce: (candidate) => {
          if (candidate === null) return; // end-of-candidates; nothing to trickle
          this.pendingLocalIce.push(candidate);
          this.apply({ kind: "localIce", rtcId });
        },
        onConnectionState: (connection) => {
          this.apply({ kind: "peerState", rtcId, connection });
        },
      });
      this.peer = peer;

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
      const d = describeDisplays(monitor);
      this.opts.send(buildDisplays(rtcId, d.count, d.active, d.width, d.height));

      const sdp = await peer.createOffer();
      this.apply({ kind: "offerReady", rtcId, sdp });
    } catch (e) {
      this.apply({ kind: "fail", rtcId, message: `Couldn't start live screen: ${(e as Error).message}` });
    }
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
    try {
      this.capture?.stop();
    } catch {
      /* already stopped */
    }
    this.capture = null;
    this.input = null;
    const peer = this.peer;
    this.peer = null;
    this.pendingLocalIce = [];
    this.pendingRemoteIce = [];
    if (peer) await peer.close();
  }
}
