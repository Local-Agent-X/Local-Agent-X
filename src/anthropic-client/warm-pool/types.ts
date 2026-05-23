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
  saxPort?: number;
  /** Required when sessionId is set. */
  saxToken?: string;
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
  buffer: string;
  stderr: string;
  /** Path to a generated MCP config file, deleted on process exit. */
  mcpConfigPath: string | null;
}

export function keyStr(k: WarmPoolKey): string {
  return `${k.model}::${k.permissionMode}::${k.sessionId ?? "shared"}`;
}
