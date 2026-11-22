// What every WebRTC peer here stands on: the lazy werift load, the connection
// states a peer reports, and the trickle ICE candidate it exchanges. The
// live-screen peer (screen-stream/peer.ts) and the voice peer
// (voice/voice-peer.ts) each wrote these out, and the voice socket a third
// copy of the candidate, so that neither feature imported the other. They
// import this instead: it knows about neither.

// werift is a heavy WebRTC stack and both peers are on-demand features. It is
// loaded LAZILY (a dynamic import on first use) so it never enters the module
// graph at boot: the peers are reachable from the chat-ws import chain, and a
// static `import … from "werift"` makes a missing or unbundled werift a fatal
// ERR_MODULE_NOT_FOUND that takes the whole app down on startup. With the lazy
// import an absent dep degrades just the feature that asked for it (the call
// site catches the rejected import). The type below is erased at compile time.
export type WeriftModule = typeof import("werift");

let weriftPromise: Promise<WeriftModule> | null = null;

/** werift, imported on first use and once for every peer. */
export function loadWerift(): Promise<WeriftModule> {
  return (weriftPromise ??= import("werift"));
}

/** Peer connection states forwarded to the signaling machine. */
export type PeerState = "new" | "connecting" | "connected" | "disconnected" | "failed" | "closed";

/** A trickle ICE candidate as both signaling paths carry it (the
 *  RTCIceCandidateInit subset). A peer here sets all three fields; one that
 *  arrives from the phone may leave the last two out. */
export interface RtcIceCandidate {
  candidate: string;
  sdpMid?: string | null;
  sdpMLineIndex?: number | null;
}
