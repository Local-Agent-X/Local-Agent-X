// Removing chats over HTTP (session/remove.ts owns what each one does):
//   DELETE /api/sessions             Delete all: Conversations leave the lists, kept on disk
//   DELETE /api/sessions/<id>        Delete one: it leaves the lists, kept in memory
//   POST   /api/sessions/<id>/erase  Erase one for good, on every synced machine
//   POST   /api/sessions/<id>/fresh  Start a reused id over, the old chat archived
// Each tells open tabs the list changed (`chat_list_changed`). The phone reaches
// these through the /api/sessions device prefix (broker-transport/device-paths.ts).
import type { IncomingMessage, ServerResponse } from "node:http";

import type { Role } from "../rbac.js";
import type { ServerContext } from "../server-context.js";
import { isValidSessionId, jsonResponse } from "../server-utils.js";
import { eraseChat, removeAllChatsFromLists, removeChatFromLists, startChatFresh } from "../session/remove.js";

export async function handleSessionRemovalRoutes(
  method: string, url: URL, req: IncomingMessage, res: ServerResponse, ctx: ServerContext, role: Role,
): Promise<boolean> {
  const json = (status: number, data: unknown) => jsonResponse(res, status, data, req);
  const listChanged = () => ctx.broadcastAll({ type: "chat_list_changed", at: Date.now() });

  // Delete all. It once unlinked every log, and an agent reaching for it as
  // "clear the sidebar" destroyed real chats; now neither it nor sidebar_clear
  // destroys anything. `?keep=<id>` stays listed.
  if (method === "DELETE" && url.pathname === "/api/sessions") {
    const removed = await removeAllChatsFromLists(ctx, url.searchParams.get("keep") ?? undefined);
    listChanged();
    json(200, { ok: true, removed });
    return true;
  }

  const action = /^\/api\/sessions\/([^/]+)\/(erase|fresh)$/.exec(url.pathname);
  if (method === "POST" && action) {
    const [, id, verb] = action as unknown as [string, string, "erase" | "fresh"];
    if (!isValidSessionId(id)) { json(400, { error: "Invalid session ID" }); return true; }
    // The user's call only: the agent may delete a chat, never erase one.
    if (verb === "erase" && role === "agent") { json(403, { error: "Only the user can erase a chat, from the chat's menu in the sidebar or on the phone." }); return true; }
    // A running turn would save the chat back as it finished.
    if (ctx.chatWs.getActiveChats().includes(id)) { json(409, { error: `This chat is still working. Stop it, then ${verb === "erase" ? "erase it" : "start fresh"}.` }); return true; }
    if (verb === "fresh") { json(200, { ok: true, archived: await startChatFresh(ctx, id) }); return true; }
    const erased = await eraseChat(ctx, id);
    listChanged();
    json(200, { ok: true, erased });
    return true;
  }

  if (method === "DELETE" && url.pathname.startsWith("/api/sessions/")) {
    const id = url.pathname.split("/").pop()!;
    if (!isValidSessionId(id)) { json(400, { error: "Invalid session ID" }); return true; }
    const removed = await removeChatFromLists(ctx, id);
    listChanged();
    json(200, { ok: true, removed });
    return true;
  }

  return false;
}
