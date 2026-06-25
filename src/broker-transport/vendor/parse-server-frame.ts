// VENDORED from agentxos/packages/client/src/parse-server-frame.ts — DO NOT HAND-EDIT.
// Re-sync on a protocol bump. Only change vs. upstream: the protocol import path.
//
// Boundary validation for broker → client frames. The protocol package validates the
// client → broker direction (parseClientFrame); this is the mirror the CLIENT needs —
// it consumes ServerFrames over an untrusted socket, so each one is parsed and
// narrowed before BrokerClient acts on it.

import { isDeviceRole, parseRtcSignal } from "./protocol.js";
import type { BrokerErrorCode, IceServer, ServerFrame } from "./protocol.js";

// narrowing an untrusted JSON value to an index signature for field checks
function asRecord(raw: unknown): Record<string, unknown> | null {
  return typeof raw === "object" && raw !== null ? (raw as Record<string, unknown>) : null;
}

// The closed set of gate/auth error codes the broker can send. Kept in sync with
// protocol.ts's BrokerErrorCode (SHARED ANCHOR there). An unknown code from a future
// broker is rejected here rather than passed through as a bogus string.
//
// Accept EVERY code the protocol's BrokerErrorCode defines, including `not_entitled`.
// The current broker maps beta gate-(a) failures onto `subscription_inactive` (gate.ts),
// so it doesn't emit `not_entitled` yet — but accepting it is correct forward-compat: a
// future broker can emit it without dropping the frame here (which would hang the UI).
// Kept in sync with protocol.ts's BrokerErrorCode (SHARED ANCHOR there).
const ERROR_CODES: readonly BrokerErrorCode[] = [
  "bad_frame",
  "role_taken",
  "no_peer",
  "bad_request",
  "unauthorized",
  "subscription_inactive",
  "not_paired",
  "turn_unavailable",
  "not_entitled",
];

function isBrokerErrorCode(v: unknown): v is BrokerErrorCode {
  return typeof v === "string" && (ERROR_CODES as readonly string[]).includes(v);
}

/** One untrusted ICE-server entry → the standard RTCIceServer subset, or null. */
function parseIceServer(raw: unknown): IceServer | null {
  const r = asRecord(raw);
  if (!r) return null;
  const urlsOk =
    typeof r.urls === "string" ||
    (Array.isArray(r.urls) && r.urls.every((u) => typeof u === "string"));
  if (!urlsOk) return null;
  // urls is now string | string[]; username/credential are optional strings.
  const urls = r.urls as string | string[];
  const server: IceServer = { urls };
  if (typeof r.username === "string") server.username = r.username;
  if (typeof r.credential === "string") server.credential = r.credential;
  return server;
}

/**
 * Parse + validate a single broker → client frame. Returns null for anything
 * malformed so BrokerClient ignores it instead of throwing on the message path.
 */
export function parseServerFrame(raw: unknown): ServerFrame | null {
  const r = asRecord(raw);
  if (!r || typeof r.type !== "string") return null;

  switch (r.type) {
    case "joined":
      return isDeviceRole(r.role) && typeof r.peerPresent === "boolean"
        ? { type: "joined", role: r.role, peerPresent: r.peerPresent }
        : null;

    case "peer-joined":
      return { type: "peer-joined" };

    case "peer-left":
      return { type: "peer-left" };

    case "signal": {
      const signal = parseRtcSignal(r.signal);
      return signal ? { type: "signal", signal } : null;
    }

    case "ice-servers": {
      if (!Array.isArray(r.iceServers) || typeof r.ttlSeconds !== "number") return null;
      const servers: IceServer[] = [];
      for (const entry of r.iceServers) {
        const parsed = parseIceServer(entry);
        if (!parsed) return null; // one bad entry invalidates the frame, not just the entry
        servers.push(parsed);
      }
      return { type: "ice-servers", iceServers: servers, ttlSeconds: r.ttlSeconds };
    }

    case "error":
      return isBrokerErrorCode(r.code) && typeof r.message === "string"
        ? { type: "error", code: r.code, message: r.message }
        : null;

    default:
      return null;
  }
}
