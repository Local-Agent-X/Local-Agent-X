/**
 * Warm-pool of long-lived `claude -p --input-format=stream-json` processes.
 *
 * Validated by `scripts/spike-claude-warm-pool.mjs`: the CLI accepts
 * multiple consecutive prompts via stdin JSON-lines without re-spawning.
 * Cold start (~2-4s) is paid once per process; warm turns drop first-byte
 * latency from ~2000ms to ~4ms.
 *
 * Two pool modes:
 *   - **Text-only** (no sessionId, no MCP): processes are interchangeable
 *     across sessions. Keyed by `(model, permissionMode)`. Used when the
 *     caller passes `tools=[]`.
 *   - **Tool / MCP** (sessionId present): one warm process per session.
 *     The MCP bridge subprocess that the CLI spawns at startup carries
 *     `LAX_MCP_SESSION_ID` so its `/api/mcp/call` POSTs route side-effects
 *     to the right WebSocket. That binding is fixed at spawn → can't be
 *     shared across sessions, hence per-session keying. Pool size still 1
 *     per (model, permissionMode, sessionId) tuple.
 *
 * Lifecycle:
 *   - `acquire()` returns an idle process or spawns one if pool not full.
 *   - `streamViaWarmPool()` locks the process, writes one JSON-line to
 *     stdin, reads stdout until the `result` frame, yields StreamEvents,
 *     releases.
 *   - Abort signal kills the process (CLI has no in-band abort) when the
 *     reason matches /idle|stalled|stop/i; otherwise drains silently.
 *   - Idle processes evict after 30 minutes; bounded resource use.
 *
 * Default ON. Cold-spawning the Claude CLI on every call is the dominant
 * Anthropic latency, especially on Windows (~2-5s per spawn) — it hit the
 * classifier AND every chat turn. Opt OUT with `LAX_CLAUDE_WARM_POOL=0`
 * (falls back to the per-request `streamViaCliWithTools` cold-spawn path).
 *
 * Helpers split into ./warm-pool/* — this file is the public surface.
 */

export function isWarmPoolEnabled(): boolean {
  const raw = (process.env.LAX_CLAUDE_WARM_POOL ?? "").trim().toLowerCase();
  // Default-on: only an explicit falsey opt-out disables it.
  return !(raw === "0" || raw === "false" || raw === "no" || raw === "off");
}

export { streamViaWarmPool } from "./warm-pool/stream-prompt.js";
export { shutdownWarmPool, warmPoolSnapshot } from "./warm-pool/pool.js";
export type { WarmPoolKey } from "./warm-pool/types.js";
