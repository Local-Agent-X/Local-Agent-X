// @agentxos/client — the shared, dependency-free broker SIGNALING client and the
// account API client. Both the desktop (Local-Agent-X/src/broker-transport/) and the
// phone (agentxos-mobile/app/src/broker/) vendor this package to dial the agentxos
// broker and to sign in, register and pair. It is a pure state machine over an injected
// socket + RTC hooks — no real WebSocket/RTCPeerConnection/Cloudflare/React-Native
// types — so it carries zero secrets and unit tests offline.
//
// See docs/integration-lax-mobile.md for the step-by-step old→new wiring.

export { BrokerClient, CLOSE_UNAUTHORIZED, CLOSE_GATE_DENIED } from "./broker-client.js";
export type { BrokerClientState, BrokerClientHooks } from "./broker-client.js";

export { buildConnectUrl } from "./connect-url.js";
export type { ConnectParams } from "./connect-url.js";

export { serializeClientFrame } from "./socket-adapter.js";
export type { SocketAdapter, CloseReason } from "./socket-adapter.js";

export { parseServerFrame } from "./parse-server-frame.js";

// The account API and device-code login, one copy for the desktop and the phone (each
// keeps only its own storage, identity and screens).
export { AgentxosApiClient, ApiError, DEFAULT_ACCOUNT_API_URL } from "./account-api.js";
export type {
  StartedDeviceCode,
  DeviceCodePoll,
  RegisteredDevice,
  IssuedPairing,
  RedeemedPairing,
  PairingEntry,
  FetchLike,
} from "./account-api.js";
export { deviceCodeLogin } from "./device-code-login.js";
export type { DeviceCodeApi, DeviceCodeLoginDeps, LoginPrompt, LoginResult } from "./device-code-login.js";

// Re-export the whole wire contract so a vendoring repo imports everything it needs
// from one place (the protocol stays the single source of truth for the shapes).
export * from "./protocol.js";
