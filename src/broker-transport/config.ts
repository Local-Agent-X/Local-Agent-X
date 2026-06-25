// Broker-transport configuration + the kill-switch flag that keeps this whole path
// DARK by default. The live-screen feature ships today over the tailnet /ws/chat
// signaling; this module decides whether to instead dial the agentxos broker.
//
// SAFETY: `LAX_TRANSPORT` defaults to "tailnet". Nothing here changes the live-screen
// behavior of an installed (OTA) build unless the operator explicitly sets
// LAX_TRANSPORT=broker AND supplies the broker dial credentials. That is the
// guardrail in docs/integration-lax-mobile.md — never blind-swap the transport on
// the OTA channel; flip the flag on a controlled build and verify across networks.
//
// Until account-login + QR-pairing land (D4/D5), the dial credentials come from env
// so the broker transport can be exercised on a controlled build with a pre-seeded
// account/device/pairing (exactly how agentxos' dev-real-demo proved the relay).
// When login/pairing land, replace `loadBrokerConfig`'s env reads with the stored
// session token + the paired-peer id from the redeemed pairing — nothing else changes.

/** The signaling transport for live-screen. "tailnet" = today's /ws/chat path
 *  (default). "broker" = dial the agentxos broker (this module's path). */
export type TransportMode = "tailnet" | "broker";

/** Fully-resolved broker dial parameters. Present only when the broker transport is
 *  both enabled AND completely configured; a partial config resolves to null so the
 *  caller falls back to the tailnet path rather than dialing a malformed URL. */
export interface BrokerConfig {
  /** Broker base URL, ws:// or wss:// (no /connect suffix — buildConnectUrl adds it). */
  brokerWsUrl: string;
  /** This desktop's own device id (the broker proves the account owns it). */
  deviceId: string;
  /** The paired phone's device id — the `target` this desktop waits to meet. */
  pairedPhoneId: string;
  /** The per-session bearer credential (the web-issued session token). Supplied at
   *  dial time, never a static secret in the bundle (constitution §6). */
  token: string;
}

/** The default production broker. Overridable via LAX_BROKER_URL for staging/dev. */
const DEFAULT_BROKER_URL = "wss://broker.agentxos.ai";

/** Read the requested transport mode. Anything other than the explicit string
 *  "broker" — including unset — means the tailnet path (fail safe, not fail open). */
export function transportMode(env: NodeJS.ProcessEnv = process.env): TransportMode {
  return env.LAX_TRANSPORT?.trim() === "broker" ? "broker" : "tailnet";
}

/**
 * Resolve the broker dial config, or null when the broker transport should not run.
 * Returns null (→ caller uses the tailnet path) when the flag is off OR any required
 * dial parameter is missing — a half-configured broker transport must NOT silently
 * partially activate (constitution: no silent fallback; deny by default).
 */
export function loadBrokerConfig(env: NodeJS.ProcessEnv = process.env): BrokerConfig | null {
  if (transportMode(env) !== "broker") return null;

  const brokerWsUrl = env.LAX_BROKER_URL?.trim() || DEFAULT_BROKER_URL;
  const deviceId = env.LAX_DEVICE_ID?.trim();
  const pairedPhoneId = env.LAX_PAIRED_PHONE_ID?.trim();
  const token = env.LAX_BROKER_TOKEN?.trim();

  if (!deviceId || !pairedPhoneId || !token) return null;
  return { brokerWsUrl, deviceId, pairedPhoneId, token };
}
