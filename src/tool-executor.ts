// Public re-export shim. The pipeline lives in src/tool-execution/.
// Existing callers (chat-tool-dispatcher, routes/chat, routes/mcp, tests)
// import from this path unchanged.

export * from "./tool-execution/index.js";
