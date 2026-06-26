// Broker-transport configuration. The agentxos broker is the ONLY phone↔desktop
// transport (the tailnet bridge has been removed), so this module resolves the
// broker dial parameters; it no longer chooses between transports.
//
// The dial credentials come from env so the broker transport can be exercised on
// a controlled build with a pre-seeded account/device/pairing (exactly how
// agentxos' dev-real-demo proved the relay). When account-login + QR-pairing are
// wired through, replace `loadBrokerConfig`'s env reads with the stored session
// token + the paired-peer id from the redeemed pairing — nothing else changes.

/** The phone↔desktop transport. "broker" = dial the agentxos broker — the only
 *  transport now that the tailnet bridge is gone. */
export type TransportMode = "broker";

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

/** The transport mode. The tailnet bridge has been removed, so the broker is the
 *  only phone↔desktop transport — always "broker". */
export function transportMode(_env: NodeJS.ProcessEnv = process.env): TransportMode {
  return "broker";
}

/**
 * Resolve the broker dial config, or null when it can't run. Returns null when
 * any required dial parameter is missing — a half-configured broker transport
 * must NOT silently partially activate (constitution: no silent fallback; deny
 * by default).
 */
export function loadBrokerConfig(env: NodeJS.ProcessEnv = process.env): BrokerConfig | null {
  const brokerWsUrl = env.LAX_BROKER_URL?.trim() || DEFAULT_BROKER_URL;
  const deviceId = env.LAX_DEVICE_ID?.trim();
  const pairedPhoneId = env.LAX_PAIRED_PHONE_ID?.trim();
  const token = env.LAX_BROKER_TOKEN?.trim();

  if (!deviceId || !pairedPhoneId || !token) return null;
  return { brokerWsUrl, deviceId, pairedPhoneId, token };
}
