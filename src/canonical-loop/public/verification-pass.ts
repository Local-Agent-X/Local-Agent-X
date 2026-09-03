/**
 * canonical-loop public sub-barrel: the deliverable-verification pass.
 *
 * The host-facing hooks for the verification tier (verification-trigger.ts
 * observes; verification-spend.ts decides what it costs). Today that is one
 * symbol: the graceful-shutdown owner (server/lifecycle.ts registerShutdown)
 * drops every armed quiet period before teardown, so a debounce timer cannot
 * fire into a runtime that is closing.
 *
 * A sub-barrel rather than the front door because index.js is a heavy barrel
 * at the LOC gate's ceiling, and because verification-spend.ts is light — it
 * pulls only config, op-store and session-bridge — so this stays cycle-safe
 * for callers inside canonical-loop's runtime orbit too.
 *
 * NOT to be confused with public/verify-bridge.ts, which is the app-build
 * render/design verification bridge — a different tier entirely.
 */
export { cancelAllVerificationDebounces } from "../verification-spend.js";
