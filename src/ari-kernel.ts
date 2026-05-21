// Public re-export shim. The kernel pipeline lives in src/ari-kernel/.
// Existing callers (routes/security, server/lifecycle,
// tool-execution/enforce-policy, tests) import from this path unchanged.

export * from "./ari-kernel/index.js";
