// ───────────────────────────────────────────────────────────────────────────
// VENDORED from agentxos/packages/protocol/src/index.ts — DO NOT HAND-EDIT.
// Re-sync from that file when the broker protocol version bumps (constitution §5:
// the wire contract is deliberately small + stable so this copy stays cheap). The
// only change vs. upstream is import specifiers (none here) — the source is pure.
//
// LATENT NOTE: BrokerErrorCode below includes `not_entitled`, but the broker's
// gate (workers/broker/src/gate.ts denyCode) currently only ever emits
// `subscription_inactive` / `not_paired`, and vendor/parse-server-frame.ts's
// allowlist omits `not_entitled` to match. If the broker is ever changed to send
// `not_entitled`, add it to that allowlist here too or the client will drop it.
// ───────────────────────────────────────────────────────────────────────────

// Wire contract shared by the broker, the desktop client, and the phone client.
// Kept deliberately small and stable so the two pre-existing client repos can
// copy/import it cheaply (see spec/constitution.md §5). The broker relays the
// WebRTC signaling opaquely — media is end-to-end encrypted and never inspected.

export const BROKER_PROTOCOL_VERSION = 1;

export type DeviceRole = "desktop" | "phone";

/** WebRTC signaling, relayed verbatim by the broker (never inspected). */
export type RtcSignal =
  | { kind: "offer"; sdp: string }
  | { kind: "answer"; sdp: string }
  | { kind: "ice"; candidate: string; sdpMid: string | null; sdpMLineIndex: number | null };

/** One ICE server for an RTCPeerConnection — the standard RTCIceServer shape. STUN
 *  entries carry just `urls`; TURN entries also carry the broker-minted short-lived
 *  `username`/`credential` (constitution §10). The broker mints these per session,
 *  only after both gates pass; TURN only ever relays DTLS-SRTP ciphertext (§9). */
export type IceServer = {
  urls: string | string[];
  username?: string;
  credential?: string;
};

/** client → broker */
export type ClientFrame = { type: "signal"; signal: RtcSignal };

// SHARED ANCHOR: clients import this. Only ever ADD codes — never rename/remove
// existing ones, or a deployed client's matcher breaks.
export type BrokerErrorCode =
  | "bad_frame"
  | "role_taken"
  | "no_peer"
  | "bad_request"
  | "unauthorized"
  | "subscription_inactive"
  | "not_paired"
  | "turn_unavailable"
  | "not_entitled";

// SHARED ANCHOR: clients match on `type`. Only ever ADD variants.
/** broker → client */
export type ServerFrame =
  | { type: "joined"; role: DeviceRole; peerPresent: boolean }
  | { type: "peer-joined" }
  | { type: "peer-left" }
  | { type: "signal"; signal: RtcSignal }
  | { type: "ice-servers"; iceServers: IceServer[]; ttlSeconds: number }
  | { type: "error"; code: BrokerErrorCode; message: string };

export function isDeviceRole(v: unknown): v is DeviceRole {
  return v === "desktop" || v === "phone";
}

// Boundary validation: frames arrive over the wire as untrusted JSON, so each
// field is checked before it is trusted (constitution: validate at boundaries).
function asRecord(raw: unknown): Record<string, unknown> | null {
  return typeof raw === "object" && raw !== null ? (raw as Record<string, unknown>) : null;
}

export function parseRtcSignal(raw: unknown): RtcSignal | null {
  const r = asRecord(raw);
  if (!r) return null;
  if (r.kind === "offer" || r.kind === "answer") {
    return typeof r.sdp === "string" ? { kind: r.kind, sdp: r.sdp } : null;
  }
  if (r.kind === "ice") {
    if (typeof r.candidate !== "string") return null;
    const mid = r.sdpMid === null ? null : typeof r.sdpMid === "string" ? r.sdpMid : undefined;
    const idx = r.sdpMLineIndex === null ? null : typeof r.sdpMLineIndex === "number" ? r.sdpMLineIndex : undefined;
    if (mid === undefined || idx === undefined) return null;
    return { kind: "ice", candidate: r.candidate, sdpMid: mid, sdpMLineIndex: idx };
  }
  return null;
}

export function parseClientFrame(raw: unknown): ClientFrame | null {
  const r = asRecord(raw);
  if (!r || r.type !== "signal") return null;
  const signal = parseRtcSignal(r.signal);
  return signal ? { type: "signal", signal } : null;
}
