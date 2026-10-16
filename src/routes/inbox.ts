// The user inbox over HTTP: the bell's list and the user's answers to it.
//
// GET  /api/inbox               → { items, unread, needsYou }
// POST /api/inbox/read          { id } → mark one read
// POST /api/inbox/read-all      → mark every visible item read
// POST /api/inbox/dismiss       { id } → hide it (soft; see src/inbox/store.ts)
// POST /api/inbox/resolve       { id } → the user dealt with it
//
// Every mutation broadcasts `inbox_changed` with the new counts so every open
// tab redraws. The agent principal is refused outright: the inbox is the
// user's channel, and an agent that could dismiss or resolve items could hide
// what it was refused (and, in phase 2, approve its own parked calls).

import type { RouteHandler } from "../server-context.js";
import { jsonResponse, safeParseBody } from "../server-utils.js";
import { inboxStore, listInbox, type InboxFrame, type InboxStore } from "../inbox/index.js";

type Mutation = Extract<InboxFrame, { type: "inbox_changed" }>["action"];

const MUTATIONS: Record<string, { action: Mutation; apply: (store: InboxStore, id: string) => boolean }> = {
  "/api/inbox/read": { action: "read", apply: (store, id) => store.markRead(id) },
  "/api/inbox/read-all": { action: "read_all", apply: (store) => { store.markAllRead(); return true; } },
  "/api/inbox/dismiss": { action: "dismiss", apply: (store, id) => store.dismiss(id) },
  "/api/inbox/resolve": { action: "resolve", apply: (store, id) => store.resolve(id) },
};

export const handleInboxRoutes: RouteHandler = async (method, url, req, res, ctx, role) => {
  if (url.pathname !== "/api/inbox" && !url.pathname.startsWith("/api/inbox/")) return false;
  const json = (status: number, data: unknown) => jsonResponse(res, status, data, req);
  if (role === "agent") { json(403, { error: "The inbox is the user's; only they read and answer it." }); return true; }

  if (method === "GET" && url.pathname === "/api/inbox") { json(200, listInbox()); return true; }

  const mutation = method === "POST" ? MUTATIONS[url.pathname] : undefined;
  if (!mutation) return false;
  if (role !== "operator" && role !== "user") { json(403, { error: "Answering the inbox requires operator or user role" }); return true; }

  let id = "";
  if (mutation.action !== "read_all") {
    const body = await safeParseBody(req);
    if (body === null) { json(400, { error: "Invalid JSON" }); return true; }
    id = typeof body.id === "string" ? body.id : "";
    if (!id) { json(400, { error: "id is required" }); return true; }
  }
  const store = inboxStore();
  if (!mutation.apply(store, id)) { json(404, { error: `No inbox item ${id}` }); return true; }
  const counts = store.counts();
  const frame: InboxFrame = { type: "inbox_changed", action: mutation.action, ...(id ? { id } : {}), ...counts };
  ctx.broadcastAll(frame as unknown as Record<string, unknown>);
  json(200, { ok: true, ...counts });
  return true;
};
