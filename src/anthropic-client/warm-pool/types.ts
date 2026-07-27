// Shared types for the warm-pool. Kept here (not on the entry file) so
// pool.ts, spawn.ts, and stream-prompt.ts can import a single source of
// truth for the key/process shapes.

import type { ChildProcessWithoutNullStreams } from "node:child_process";

export type PermissionMode = "plan" | "bypassPermissions" | "auto" | "default";

export interface WarmPoolKey {
  model: string;
  permissionMode: PermissionMode;
  /**
   * When set, the warm process is bound to this chat session: it spawns
   * an MCP bridge with `LAX_MCP_SESSION_ID=sessionId`, so tool calls'
   * side-effects route to the right WebSocket. Unset = text-only pool.
   */
  sessionId?: string;
  /** Required when sessionId is set. */
  laxPort?: number;
  /** Required when sessionId is set. */
  laxToken?: string;
}

export interface WarmProcess {
  proc: ChildProcessWithoutNullStreams;
  key: string;
  state: "idle" | "busy" | "dead";
  lastUsedAt: number;
  spawnedAt: number;
  // Stdout demux: a single pump reads stdout, parsed JSON frames are routed
  // to the active prompt's listener. When idle, frames are ignored
  // (shouldn't happen; CLI is silent between prompts).
  activeListener: ((frame: unknown) => void) | null;
  /**
   * Wakes the in-flight per-turn driver when this process dies.
   *
   * `activeListener` only ever fires on a stdout FRAME. A process that dies
   * without emitting one — an instant spawn failure (`'claude' is not
   * recognized`), a crash, or a kill — left the driver awaiting a frame that
   * could never arrive, and the await had no other resolver. That hung the
   * turn forever, which wedged the cap-1 background lane and stalled every
   * queued op behind it (2026-07-26: six dreams failed by the next boot sweep
   * having never run a turn). The 600s idle watchdog could not save it either:
   * its abort path also only set `state = "dead"`, so the same await stayed
   * pending. Death must be an EVENT, not a flag someone might poll.
   */
  deathListener: (() => void) | null;
  buffer: string;
  stderr: string;
  /** Path to a generated MCP config file, deleted on process exit. */
  mcpConfigPath: string | null;
}

export function keyStr(k: WarmPoolKey): string {
  return `${k.model}::${k.permissionMode}::${k.sessionId ?? "shared"}`;
}
