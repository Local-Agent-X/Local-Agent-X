import type { RtcSignal } from "./vendor/protocol.js";

/** A desktop ICE candidate in the minimal shape both dialers emit. The voice and
 *  screen peers expose their own RtcIceCandidate types; this structural subset is
 *  what {@link iceSignal} needs and both satisfy. */
export interface DialerIceCandidate {
  candidate: string;
  sdpMid?: string | null;
  sdpMLineIndex?: number | null;
}

/** Map a desktop ICE candidate to the broker's ice signal, coercing the optional
 *  sdpMid/sdpMLineIndex to the explicit `null` the wire contract requires. One home
 *  so the voice and screen dialers can't drift on the coercion. */
export function iceSignal(c: DialerIceCandidate): RtcSignal {
  return { kind: "ice", candidate: c.candidate, sdpMid: c.sdpMid ?? null, sdpMLineIndex: c.sdpMLineIndex ?? null };
}
