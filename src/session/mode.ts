/**
 * A chat's mode: an ordinary chat, or a code session that works in one
 * project folder with the code prompt profile (fewer prompt parts, the coding
 * kit up front, everything else through tool_search).
 *
 * The mode is fixed when the session is created and never taken from a later
 * frame: switching a session's prompt mid-conversation would break the prompt
 * cache and change the rules under the model. A session with no stored mode is
 * a chat, which is what every session before modes existed reads as. The App
 * IDE's sessions (`ide-<appId>`) are code sessions by their id, so an IDE chat
 * created before modes existed is one too.
 *
 * Leaf: no local imports, so the Session type can import it.
 */
export type ChatMode = "chat" | "code";

/** A frame's or request's mode field, or undefined when it names none. */
export function parseChatMode(value: unknown): ChatMode | undefined {
  return value === "code" || value === "chat" ? value : undefined;
}

/** The mode a session runs in. */
export function sessionModeOf(session: { id: string; mode?: ChatMode }): ChatMode {
  if (session.id.startsWith("ide-")) return "code";
  return session.mode ?? "chat";
}
