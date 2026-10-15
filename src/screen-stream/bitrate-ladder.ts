// How hard the live screen pushes the network: a few bitrate tiers, stepped by what the
// phone reports back about the stream (RTCP receiver reports: packet loss, round-trip
// time).
//
// WHY: ffmpeg encodes at whatever bitrate it was started with and never hears from the
// network. On cellular a fixed 2 Mbps overfills the carrier's buffers, so delay grows
// instead of the picture getting softer, and losses smear the picture until the next
// keyframe. Loss and a rising round-trip time are the two signals that the path is
// over-full; stepping down fast and up slowly is the standard response.
//
// Pure: the caller feeds reports and a clock and restarts capture on a step.

/** Video bitrates the encoder can be started at, best first (kbps). */
export const BITRATE_TIERS_KBPS = [2000, 1200, 700, 400] as const;

/** One receiver report: loss is a fraction (0..1) of packets since the last report. */
export interface StreamReport {
  fractionLost: number;
  rttMs?: number;
}

const HEAVY_LOSS = 0.1;
const LOSS = 0.04;
const SLOW_RTT_MS = 400;
const CLEAN_LOSS = 0.02;
const CLEAN_RTT_MS = 250;
/** No second step this soon after one: the new encoder needs a moment to show its effect. */
const HOLD_MS = 4000;
/** Stay clean this long before trying the next tier up. */
const UP_AFTER_MS = 10_000;

export class BitrateLadder {
  private tier = 0;
  private lastStepAt: number;
  private cleanSince: number | null;
  private strained = 0;

  constructor(private readonly now: () => number = Date.now) {
    this.lastStepAt = now();
    this.cleanSince = this.lastStepAt;
  }

  get kbps(): number {
    return BITRATE_TIERS_KBPS[this.tier]!;
  }

  /** Fold one report. Returns the new bitrate when the tier changed, else null. */
  report(r: StreamReport): number | null {
    const t = this.now();
    const slow = r.rttMs !== undefined && r.rttMs >= SLOW_RTT_MS;
    const lossy = r.fractionLost >= LOSS;
    this.strained = lossy || slow ? this.strained + 1 : 0;
    const clean = r.fractionLost < CLEAN_LOSS && (r.rttMs === undefined || r.rttMs < CLEAN_RTT_MS);
    if (!clean) this.cleanSince = null;
    else if (this.cleanSince === null) this.cleanSince = t;

    if (t - this.lastStepAt < HOLD_MS) return null;
    const down = r.fractionLost >= HEAVY_LOSS || this.strained >= 2;
    if (down && this.tier < BITRATE_TIERS_KBPS.length - 1) return this.step(this.tier + 1, t);
    if (this.cleanSince !== null && t - this.cleanSince >= UP_AFTER_MS && this.tier > 0) return this.step(this.tier - 1, t);
    return null;
  }

  private step(tier: number, t: number): number {
    this.tier = tier;
    this.lastStepAt = t;
    this.strained = 0;
    this.cleanSince = null;
    return this.kbps;
  }
}
