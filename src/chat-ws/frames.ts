// The frames the server sends a browser tab over the chat socket, as one
// union. A frame is either the per-session envelope (`event`, carrying a
// ServerEvent) or a top-level control frame every tab acts on (settings
// changed, pins changed, an agent card update, …). Every producer —
// broadcastAll, the per-socket sendFrame — takes a GlobalFrame, so a frame
// type exists exactly once and the compiler holds each producer to its shape;
// frames.test.ts then checks the other side: every type here has a handler in
// public/js or an entry saying why not, and every type the browser handles is
// produced.
import type { WebSocket } from "ws";
import type { ServerEvent } from "../types.js";
import type { InboxFrame } from "../inbox/types.js";
import type { WorkersSnapshotFrame } from "../broker-transport/vendor/protocol.js";
import type { AgentSpawnEvent, AgentResultEvent } from "../server/handler-events-agent-result.js";

export interface SidebarPin { name: string; icon: string; url: string }

/** A per-session event, relayed to the tabs subscribed to the session. */
export type SessionEventFrame = { type: "event"; sessionId: string; event: ServerEvent; _replay?: true };

export type GlobalFrame =
  | SessionEventFrame
  | { type: "active_chats"; sessionIds: string[] }
  | { type: "session_snapshot"; sessionId: string; liveOpIds: string[]; messageCount: number; planMode: boolean; learningNotices: unknown[] }
  | { type: "pong"; ts: number }
  /** A reply to a control frame the server could not act on (an agent control
   *  for a run that has ended, a redirect that failed). */
  | { type: "error"; message: string }
  /** The reply to an approval answered after the ask's process ended: the
   *  decision was recorded on the op for recovery to apply
   *  (approval-durable-resolve.ts). A live settle rides the session envelope. */
  | { type: "approval_resolved"; approvalId: string; toolName: string; approved: boolean; delivery: "delivered" | "recorded" }
  /** One or more settings changed, by field; a tab redraws what it shows for
   *  each. The keys are settings-schema fields plus the section snapshots
   *  (`egress`, `sandbox`) and the catalog flags (`plugins`, `secrets`,
   *  `mcpServers`), checked against the tab's handler by frames.test.ts. */
  | { type: "settings_changed"; settings: Record<string, unknown> }
  | { type: "sidebar_pins_changed"; pins: SidebarPin[] }
  | { type: "sidebar_clear_chats"; at: number }
  | { type: "app-files-changed"; appName: string }
  | { type: "app:state"; appId: string }
  | { type: "app:event"; appId: string; event: unknown }
  | { type: "projects_changed" }
  | { type: "learning_changed"; id: string; action: string }
  | { type: "history_changed"; sessionId: string }
  | { type: "system_health"; subsystem: string; state: "ok" | "failing"; message?: string }
  | InboxFrame
  | ({ type: "agent-spawn"; displayName: string; rawName: string; parentSessionId: string; parentAgentId: string | null } & Omit<AgentSpawnEvent, "systemPrompt">)
  | { type: "agent-update"; agentId: string; status?: string; totalTokens?: number; [key: string]: unknown }
  | { type: "agent-output"; agentId: string; output: string }
  | ({ type: "agent-complete"; displayName: string; sessionId: string; parentAgentId: string | null } & AgentResultEvent)
  | WorkersSnapshotFrame;

export type GlobalFrameType = GlobalFrame["type"];

/** Every frame type, for the two-sided test; the compiler checks it matches
 *  the union in both directions. */
export const GLOBAL_FRAME_TYPES = [
  "event", "active_chats", "session_snapshot", "pong", "error", "approval_resolved", "settings_changed", "sidebar_pins_changed",
  "sidebar_clear_chats", "app-files-changed", "app:state", "app:event", "projects_changed", "learning_changed",
  "history_changed", "system_health", "inbox_item", "inbox_changed",
  "agent-spawn", "agent-update", "agent-output", "agent-complete", "workers_snapshot",
] as const satisfies readonly GlobalFrameType[];

type MissingFromList = Exclude<GlobalFrameType, (typeof GLOBAL_FRAME_TYPES)[number]>;
const _everyFrameTypeListed: MissingFromList extends never ? true : never = true;
void _everyFrameTypeListed;

/** Send one frame on one socket. */
export function sendFrame(ws: Pick<WebSocket, "send">, frame: GlobalFrame): void {
  ws.send(JSON.stringify(frame));
}
