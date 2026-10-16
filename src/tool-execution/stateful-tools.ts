// The tools whose result depends on state that changes between otherwise-
// identical calls, read off each policy row's `liveState`
// (tool-policies.types.ts LiveState). THREE dedup/loop layers must agree on
// them or they fight:
//
//   1. resolve-tool.ts   SESSION_REPEAT_SKIP_TOOLS — session-wide identical-call
//                        dedup (cross-turn). Replaying a cached result here
//                        serves stale reality (live failure 2026-07-23: a
//                        `browser {action:"snapshot", full:true}` was deduped
//                        against a 3-hour-old login-page snapshot).
//   2. dedup-cache.ts    DEDUP_SKIP — the 60s within-op cache. Same hazard at a
//                        shorter horizon.
//   3. tool-chain.ts     detectLoops — the threat-engine hash-only loop guard.
//                        It is NOT result-aware, so a legitimate poll loop
//                        (op_wait ×12, agent_status↔agent_output ×8) would
//                        HARD-BLOCK and discard the executed — possibly
//                        "op COMPLETED" — result. detectLoops exempts the
//                        "poll" tools from its specific-pattern arms but keeps
//                        the global 40-call circuit breaker as a runaway backstop.
//
// Layers 1 and 2 skip every live-state tool; layer 3 exempts only "poll".
// Non-live reads (read/glob/grep) stay deduped and loop-guarded: their results
// are re-derivable and a repeat there really is a loop.
import { TOOL_POLICIES } from "../tool-policy/tool-policies.js";

const withLiveState = (pred: (s: string) => boolean): ReadonlySet<string> =>
  new Set(Object.entries(TOOL_POLICIES).filter(([, row]) => row.liveState && pred(row.liveState)).map(([name]) => name));

/** Tools no earlier identical call may answer for (layers 1 and 2). */
export const LIVE_STATE_TOOLS: ReadonlySet<string> = withLiveState(() => true);

/** Tools whose identical repeat is how they are used: a poll (layer 3). */
export const STATEFUL_LIVE_STATE_TOOLS: ReadonlySet<string> = withLiveState((s) => s === "poll");
