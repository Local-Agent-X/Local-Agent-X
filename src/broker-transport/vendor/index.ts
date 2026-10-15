// @agentxos/client — the shared, dependency-free broker SIGNALING client. Both the
// desktop (Local-Agent-X/src/screen-stream/) and mobile (agentxos-mobile/app/src/
// screen/) repos import OR vendor this package to dial the agentxos broker instead
// of the old tailnet /ws/chat signaling. It is a pure state machine over an injected
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

// Re-export the whole wire contract so a vendoring repo imports everything it needs
// from one place (the protocol stays the single source of truth for the shapes).
export * from "./protocol.js";
