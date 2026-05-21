// Public re-export shim. The 4 stores live in src/agent-store/.
// Existing callers (server, agents/, tools/, routes, tests) import
// from this path unchanged.

export * from "./agent-store/index.js";
