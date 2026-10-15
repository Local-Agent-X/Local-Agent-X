// Builds the broker connect URL both clients dial:
//   <brokerWsUrl>/connect?role=<desktop|phone>&target=<peer device id>[&token=…]
//
// This mirrors the broker's contract EXACTLY (workers/broker/src/worker.ts
// handleConnect): it reads `role`, `target`, and a bearer credential from either
// the `Authorization` header or a `?token=` query param. The WHATWG WebSocket
// client API cannot set request headers, so the desktop/mobile clients pass the
// credential as `?token=` here; a server-side dialer that CAN set headers should
// prefer the Authorization header and omit the token (see the integration guide).
//
// Kept pure + dependency-free (uses only the global URL) so it type-strips and unit
// tests offline with no socket. No secret is embedded — the token is supplied by the
// caller per session (constitution §6: clients hold zero static secrets).

import type { DeviceRole } from "./protocol.js";

export interface ConnectParams {
  /** Broker base URL, ws:// or wss://, e.g. "wss://broker.agentxos.com". A trailing
   *  /connect is appended; any trailing slash on the base is normalized away. */
  brokerWsUrl: string;
  /** This client's role. desktop = waits to be introduced; phone = dials its desktop. */
  role: DeviceRole;
  /** The peer device id this client is targeting. For the phone (the primary
   *  dialer) this is the paired DESKTOP device id obtained from the pairing. */
  target: string;
  /** Optional bearer credential to carry as `?token=` (when headers can't be set).
   *  Omit it if the SocketAdapter sets an Authorization: Bearer header instead. */
  token?: string;
  /** The device id this client claims to BE — the broker REQUIRES `?device=` on
   *  connect (workers/broker/src/worker.ts handleConnect 400s without it) and the
   *  real SessionDeviceAuthVerifier proves the session's account owns it. Optional in
   *  the type only so a header-setting server dialer can supply it out of band; the
   *  WS-client repos must pass it (a dial without it is refused on the wire). */
  device?: string;
  /** Optional secondary room within the SAME pairing (e.g. "voice"), so a second
   *  media peer lands in its own rendezvous + TURN session instead of colliding with
   *  the persistent screen/chat peer. Omit for the main room. The broker allowlists it. */
  channel?: string;
}

/**
 * Produce the connect URL the SocketAdapter opens. Throws on a missing/blank
 * required field — a malformed dial is a programming error here, not a runtime
 * refusal (the broker's own validation still rejects a bad role/target on the wire).
 */
export function buildConnectUrl(params: ConnectParams): string {
  const { brokerWsUrl, role, target, token, device, channel } = params;
  if (!brokerWsUrl) throw new Error("buildConnectUrl: brokerWsUrl is required");
  if (!target) throw new Error("buildConnectUrl: target device id is required");

  // Normalize: strip a single trailing slash so we don't emit "//connect".
  const base = brokerWsUrl.endsWith("/") ? brokerWsUrl.slice(0, -1) : brokerWsUrl;
  const url = new URL(base + "/connect");
  url.searchParams.set("role", role);
  url.searchParams.set("target", target);
  if (device) url.searchParams.set("device", device);
  if (token) url.searchParams.set("token", token);
  if (channel) url.searchParams.set("channel", channel);
  return url.toString();
}
