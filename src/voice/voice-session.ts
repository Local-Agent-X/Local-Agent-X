// Public re-export shim. The voice-session orchestrator lives in
// src/voice/voice-session/. Existing callers (server/lifecycle dynamic
// import, gpu-session type import) resolve through this path unchanged.

export * from "./voice-session/index.js";
