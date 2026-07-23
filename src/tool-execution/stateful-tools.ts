// One source of truth for STATEFUL live-state tools — the tools whose result
// depends on external state that changes between otherwise-identical calls, so
// an identical repeat is a legitimate re-poll rather than a stuck-loop
// hallucination. THREE dedup/loop layers must agree on this set or they fight:
//
//   1. resolve-tool.ts   SESSION_REPEAT_SKIP_TOOLS — session-wide identical-call
//                        dedup (cross-turn). Replaying a cached result here
//                        serves stale reality (live failure 2026-07-23: a
//                        `browser {action:"snapshot", full:true}` was deduped
//                        against a 3-hour-old login-page snapshot).
//   2. dedup-cache.ts    DEDUP_SKIP — the 60s within-op cache. Same hazard at a
//                        shorter horizon: a stale stateful snapshot served <60s
//                        apart AND counted toward the loop breaker below.
//   3. tool-chain.ts     detectLoops — the threat-engine hash-only loop guard.
//                        Once these tools skip layer 1 they flow into layer 3,
//                        which is NOT result-aware, so a legitimate poll loop
//                        (op_wait ×12, agent_status↔agent_output ×8) would
//                        HARD-BLOCK and discard the executed — possibly
//                        "op COMPLETED" — result. detectLoops exempts this set
//                        from its specific-pattern arms but keeps the global
//                        40-call circuit breaker as a runaway backstop.
//
// Forking three divergent lists is how those layers drift out of sync, so all
// three import THIS set. Non-stateful reads (read/glob/grep) stay deduped and
// loop-guarded: their results are re-derivable and a repeat there really is a
// loop. Pure mutations (write/edit/delete_file) are NOT here — they belong to
// each layer's own state-sensitive-mutation list, and a 12× identical write is
// a genuine stuck loop worth catching.
export const STATEFUL_LIVE_STATE_TOOLS: ReadonlySet<string> = new Set([
  // Browser: every action (navigate/snapshot/screenshot/tabs/info/extract/…)
  // reads or moves live page state that changes between calls.
  "browser",
  // Process lifecycle: status/list are live process-table reads (a repeated
  // process_status is the polling pattern); start/kill/restart are mutations
  // whose identical repeat must re-dispatch, not replay a stale success.
  "process_status", "process_list", "process_start", "process_kill", "process_restart",
  // Async-op and spawned-agent polling: identical repeated calls ARE the
  // protocol for waiting on completion. op_kill mirrors process_kill — a
  // repeated kill must re-dispatch.
  "op_status", "op_wait", "op_kill", "session_status", "agent_status", "agent_output",
  // No-arg live captures/reads: args always match, so dedup would freeze the
  // first capture for the whole session/window.
  "screen_capture", "camera_capture", "clipboard_read", "computer_position",
]);
