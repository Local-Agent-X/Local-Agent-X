// Wire contract shared by the broker, the desktop client, and the phone client.
// Kept deliberately small and stable so the two pre-existing client repos can
// copy/import it cheaply (see spec/constitution.md §5). The broker relays the
// WebRTC signaling opaquely — media is end-to-end encrypted and never inspected.

//
// Two contracts live in this package:
//   - the broker WebSocket (this file): what each device and the broker exchange;
//   - device to device, over the peer the broker introduced (link.ts, control.ts,
//     tunnel.ts, chat.ts, workers.ts, inbox.ts, voice.ts, and the device REST shapes in
//     apps.ts and sessions.ts): the broker never sees these frames.
//
// COMPATIBILITY RULE. Phones and desktops update on their own schedules, so any build
// in the field may talk to any other. Within one BROKER_PROTOCOL_VERSION a change may
// only ADD: a new optional field, a new frame or event type, a new enum value the
// receiver can ignore. Renaming or removing a field, frame, type or channel label,
// making an optional field required, or changing what a value means needs a version
// bump and a plan for the builds still running the old version. compat.test.ts holds
// frames exactly as shipped builds send them; they must keep parsing. Add fixtures
// when a frame gains a field; never edit or delete one within a version.

export const BROKER_PROTOCOL_VERSION = 1;

export * from "./link.js";
export * from "./control.js";
export * from "./chunks.js";
export * from "./tunnel.js";
export * from "./chat.js";
export * from "./file-change.js";
export * from "./approval.js";
export * from "./voice.js";
export * from "./timeline.js";
export * from "./workers.js";
export * from "./inbox.js";
export * from "./apps.js";
export * from "./sessions.js";

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
// existing ones, or a deployed client's matcher breaks. The chunk-3 additions
// (`unauthorized`, `subscription_inactive`, `not_paired`) are the two-gate
// refusals the broker sends before any rendezvous attach (constitution §8/§16).
// The chunk-6 addition (`turn_unavailable`) reports a failed TURN-credential mint to
// both peers — an actionable error, never a silent dead relay path (§16).
// The chunk-10 addition (`not_entitled`) is gate (a)'s refusal under the invite-only
// BETA model: the account has NEITHER beta access NOR an active subscription, so it
// is not entitled to connect — redeem an invite (or subscribe) to gain access (§16).
// It is ADD-only: the existing `subscription_inactive` still covers the inactive/
// expired-subscription cases, so deployed clients keep matching those unchanged.
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

// SHARED ANCHOR: clients match on `type`. Only ever ADD variants — never rename/
// remove existing ones, or a deployed client's matcher breaks. The chunk-6 addition
// (`ice-servers`) carries the broker-minted ICE config (STUN + short-lived TURN) to
// each peer once both are present and gated (constitution §9/§10, product flow 5).
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
  // narrowing an untrusted JSON value to an index signature for field checks
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
