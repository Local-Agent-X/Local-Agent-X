// The desktop server's singleton wiring for the agentxos account feature: one
// AgentxosAccountManager (real deps) + the broker-presence ACTIVATION glue. Lazily
// constructed — nothing here loads until /api/account/* is hit or activation runs at
// startup, so the feature stays off the boot graph (matching the broker-transport
// "dark until used" posture). This is the ONE place the manager's deps are assembled
// from the real adapters (api client, identity, storage, QR, clock).
//
// ACTIVATION is DARK by default: the desktop only dials the broker when
// LAX_TRANSPORT=broker AND it is signed in + paired. On the tailnet (default) this is
// inert. The presence supervisor handles reconnects; stopBrokerPresence tears it down.

import { hostname } from "node:os";
import { AgentxosApiClient, DEFAULT_ACCOUNT_API_URL } from "./api-client.js";
import { AgentxosAccountManager } from "./account-manager.js";
import { getOrCreateDeviceIdentity } from "./identity.js";
import { loadAccountState, saveAccountState, updateAccountState, clearAccountState, type AccountState } from "./storage.js";
import { renderQrDataUrl } from "./qr-render.js";
import { transportMode } from "../config.js";
import { startBrokerPresence, type BrokerPresence } from "../broker-presence.js";
import { startBrokerVoicePresence } from "../broker-voice-presence.js";
import { createLogger } from "../../logger.js";

const logger = createLogger("broker-transport.account");

/** Default production broker (overridable via LAX_BROKER_URL). */
const DEFAULT_BROKER_URL = "wss://broker.agentxos.ai";

let manager: AgentxosAccountManager | null = null;
let presence: BrokerPresence | null = null;
/** A SECOND presence in the voice rendezvous (channel=voice), so the phone can start a
 *  voice session on demand without touching the screen/chat peer. */
let voicePresence: BrokerPresence | null = null;

function accountApiUrl(): string {
  return process.env.LAX_ACCOUNT_API_URL?.trim() || DEFAULT_ACCOUNT_API_URL;
}
function brokerWsUrl(): string {
  return process.env.LAX_BROKER_URL?.trim() || DEFAULT_BROKER_URL;
}

/** The desktop's single account manager, built from the real adapters on first use. */
export function getAccountManager(): AgentxosAccountManager {
  if (manager) return manager;
  manager = new AgentxosAccountManager({
    api: new AgentxosApiClient(accountApiUrl()),
    identity: getOrCreateDeviceIdentity,
    deviceLabel: hostname() || "Desktop",
    loadState: loadAccountState,
    saveState: saveAccountState,
    updateState: updateAccountState,
    clearState: clearAccountState,
    renderQr: renderQrDataUrl,
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    now: () => Date.now(),
    // When a pairing is established, activate broker presence immediately (no restart).
    onPaired: (state) => maybeStartBrokerPresence(state),
  });
  return manager;
}

/**
 * Start the desktop's broker presence IF eligible — the flag is on AND we're signed in
 * AND paired. Idempotent (won't double-start). Called at server startup (for an
 * already-paired install) and from the manager's onPaired hook (right after pairing).
 */
export function maybeStartBrokerPresence(state: AccountState | null = loadAccountState()): void {
  if (presence) return; // already running
  if (transportMode() !== "broker") return; // DARK unless LAX_TRANSPORT=broker
  if (!state || !state.pairedPhoneId) return; // need a session + a pairing
  logger.info(`[broker-transport] activating desktop presence (device ${state.deviceId} ↔ phone ${state.pairedPhoneId})`);
  const config = {
    brokerWsUrl: brokerWsUrl(),
    deviceId: state.deviceId,
    pairedPhoneId: state.pairedPhoneId,
    // Read the token fresh each (re)dial so a re-login is picked up.
    getToken: () => loadAccountState()?.sessionToken ?? "",
  };
  presence = startBrokerPresence(config);
  // A second presence for the on-demand voice room (channel=voice). Same gating + token.
  voicePresence = startBrokerVoicePresence(config);
}

/** Stop broker presence (shutdown / sign-out). Idempotent. */
export function stopBrokerPresence(): void {
  presence?.stop();
  presence = null;
  voicePresence?.stop();
  voicePresence = null;
}
