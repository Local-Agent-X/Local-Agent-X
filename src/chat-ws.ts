// Public re-export shim. The WebSocket chat system lives in
// src/chat-ws/. Existing callers (server/lifecycle setupChatWebSocket,
// many dynamic imports for broadcastAll) resolve through this path
// unchanged.

export * from "./chat-ws/index.js";
