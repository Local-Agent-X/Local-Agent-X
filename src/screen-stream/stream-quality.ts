// Keeps the live screen inside what the phone's link can carry: steps the encoder's
// bitrate by the phone's receiver reports (bitrate-ladder.ts) and answers its keyframe
// requests. Both work by restarting capture, the one lever the ffmpeg pipeline has: a
// restarted encoder runs at its new bitrate and opens with a keyframe.
//
// Pure over an injected restart and clock, so the policy tests without ffmpeg.

import { BitrateLadder, type StreamReport } from "./bitrate-ladder.js";
import { createLogger } from "../logger.js";

const logger = createLogger("screen-stream.quality");

/** A restart freezes the picture for about half a second, so a decoder asking for
 *  keyframes over and over (a very lossy path) gets one at most this often; the
 *  encoder's own keyframe every two seconds covers the rest. */
const KEYFRAME_RESTART_MIN_MS = 3000;

export class StreamQuality {
  private readonly ladder: BitrateLadder;
  private lastRestartAt = Number.NEGATIVE_INFINITY;

  constructor(
    private readonly restart: (bitrateKbps: number) => void,
    private readonly now: () => number = Date.now,
  ) {
    this.ladder = new BitrateLadder(now);
  }

  /** The bitrate a capture should start at now. */
  get bitrateKbps(): number {
    return this.ladder.kbps;
  }

  /** One receiver report from the phone about the running stream. */
  report(r: StreamReport): void {
    const next = this.ladder.report(r);
    if (next === null) return;
    const rtt = r.rttMs === undefined ? "" : `, rtt ${Math.round(r.rttMs)}ms`;
    logger.info(`[screen-stream] bitrate → ${next} kbps (loss ${(r.fractionLost * 100).toFixed(1)}%${rtt})`);
    this.restartAt(next);
  }

  /** The phone's decoder lost its reference picture. */
  keyframeRequested(): void {
    if (this.now() - this.lastRestartAt < KEYFRAME_RESTART_MIN_MS) return;
    logger.info("[screen-stream] keyframe requested by the phone — restarting capture");
    this.restartAt(this.ladder.kbps);
  }

  private restartAt(bitrateKbps: number): void {
    this.lastRestartAt = this.now();
    this.restart(bitrateKbps);
  }
}
