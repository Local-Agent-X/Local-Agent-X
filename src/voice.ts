// Public re-export shim. The voice pipeline lives in src/voice/. Existing
// callers (audio-agent, telegram-bridge, whatsapp-bridge) import from
// this path unchanged.

export * from "./voice/index.js";
