import type { ServerContext } from "../../../server-context.js";
import type { Role } from "../../../rbac.js";
import type { ServerEvent } from "../../../types.js";

// Directive verbs that signal "the user is explicitly directing this
// attachment to a destination" — when paired with attachments, this is
// the consent signal for the threat-engine's user-consent bypass. The
// list is conservative on purpose: a vague "look at this" doesn't fire;
// "enter / submit / send / post / upload / paste / fill / add this in/to/into
// <somewhere>" does.
export const DIRECTIVE_VERB_RE = /\b(enter|submit|send|post|upload|paste|fill|add|put|record|log|register|copy)\b[^.!?]{0,80}\b(in|to|into|via|onto|inside|under|using|through)\b/i;

/**
 * Transport-agnostic sink for outbound chat events. The HTTP route handler
 * passes one that writes SSE frames to its `res`; the WS forward layer passes
 * `null` because the WS client receives events via chat-ws's own pub/sub
 * (broadcastToSession) which is wired up inside this function via
 * `ctx.chatWs.startChat(sessionId)`. Passing `null` is not a bug — it's the
 * "WS-only" mode where the SSE side-channel is intentionally absent.
 */
export type SseSink = ((event: ServerEvent) => void) | null;

export interface RunChatTurnArgs {
  sessionId: string;
  message: string;
  /** Attachments validated by ChatRequestSchema for HTTP, or passed
   *  through from the WS frame. Loose-typed because the canonical
   *  prepareAgentRequest accepts arbitrary attachment shapes. */
  attachments: Array<{ name: string; url: string; isImage: boolean }>;
  projectId: unknown;
  ctx: ServerContext;
  requestRole: Role;
  /** SSE side-channel sink. Pass null for WS-only delivery. */
  sseSink: SseSink;
}
