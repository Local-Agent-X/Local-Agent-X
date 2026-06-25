// VENDORED barrel for the agentxos broker signaling client — DO NOT HAND-EDIT.
// Re-sync from agentxos/packages/client/src/index.ts on a protocol bump. The desktop
// imports the broker client + wire types from here; the desktop-specific glue (the
// `ws`-backed SocketAdapter and the dialer) lives one level up in ../.

export { BrokerClient, CLOSE_UNAUTHORIZED, CLOSE_GATE_DENIED } from "./broker-client.js";
export type { BrokerClientState, BrokerClientHooks } from "./broker-client.js";

export { buildConnectUrl } from "./connect-url.js";
export type { ConnectParams } from "./connect-url.js";

export { serializeClientFrame } from "./socket-adapter.js";
export type { SocketAdapter, CloseReason } from "./socket-adapter.js";

export { parseServerFrame } from "./parse-server-frame.js";

// Re-export the wire contract so consumers import everything from one place.
export type {
  BrokerErrorCode,
  ClientFrame,
  DeviceRole,
  IceServer,
  RtcSignal,
  ServerFrame,
} from "./protocol.js";
