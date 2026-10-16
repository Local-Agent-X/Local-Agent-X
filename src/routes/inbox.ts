// The user inbox over HTTP: the bell's list and the user's answers to it.
//
// GET  /api/inbox               → { items, unread, needsYou }
// POST /api/inbox/read          { id } → mark one read
// POST /api/inbox/read-all      → mark every visible item read
// POST /api/inbox/dismiss       { id } → hide it (soft; see src/inbox/store.ts)
// POST /api/inbox/resolve       { id } → the user dealt with it
// POST /api/inbox/act           { id, action: "approve" | "decline" } → answer
//                               an approval (src/inbox/approvals.ts)
//
// Every mutation broadcasts `inbox_changed` with the new counts so every open
// tab redraws. The agent principal is refused outright: the inbox is the
// user's channel, and an agent that could dismiss or resolve items could hide
// what it was refused, or approve its own parked calls.

import type { RouteHandler, ServerContext } from "../server-context.js";
import { jsonResponse, safeParseBody } from "../server-utils.js";
import { inboxStore, listInbox, type InboxFrame, type InboxStore } from "../inbox/index.js";
import { approveInboxItem, declineInboxItem, type InboxActResult } from "../inbox/approvals.js";
import { dispatchApprovedCall, resolveApprovedTool } from "../tool-execution/index.js";
import { SecurityLayer } from "../security/index.js";
import { loadFileAccessModeAtLeast } from "../security/layer/index.js";
import { ThreatEngine } from "../threat/threat-engine.js";

type Mutation = Extract<InboxFrame, { type: "inbox_changed" }>["action"];

const MUTATIONS: Record<string, { action: Mutation; apply: (store: InboxStore, id: string) => boolean }> = {
  "/api/inbox/read": { action: "read", apply: (store, id) => store.markRead(id) },
  "/api/inbox/read-all": { action: "read_all", apply: (store) => { store.markAllRead(); return true; } },
  "/api/inbox/dismiss": { action: "dismiss", apply: (store, id) => store.dismiss(id) },
  "/api/inbox/resolve": { action: "resolve", apply: (store, id) => store.resolve(id) },
};

const REFUSED_STATUS = { missing: 404, "not-approval": 400, answered: 409 } as const;
const REFUSED_TEXT = {
  missing: "No such inbox item",
  "not-approval": "That item is not waiting for an approval",
  answered: "That approval was already answered",
} as const;

function broadcastChanged(ctx: ServerContext, action: Mutation, id?: string): InboxFrame {
  const frame: InboxFrame = { type: "inbox_changed", action, ...(id ? { id } : {}), ...inboxStore().counts() };
  ctx.broadcastAll(frame as unknown as Record<string, unknown>);
  return frame;
}

/** Approve runs the stored call as the unattended run would have: its
 *  session, role and context, the workspace file-access floor every
 *  unattended run gets (cron runner, ops tools), that session's threat state. */
function act(ctx: ServerContext, id: string, action: "approve" | "decline"): Promise<InboxActResult> | InboxActResult {
  if (action === "decline") return declineInboxItem(id);
  return approveInboxItem(id, {
    hasTool: (name) => resolveApprovedTool(name, ctx.allAgentTools) !== undefined,
    onAnswered: () => broadcastChanged(ctx, "approve", id),
    run: (call, itemId) => dispatchApprovedCall(call, itemId, {
      tools: ctx.allAgentTools,
      security: new SecurityLayer(ctx.config.workspace, loadFileAccessModeAtLeast("workspace")),
      toolPolicy: ctx.toolPolicy,
      rbac: ctx.rbac,
      ...(call.sessionId ? { threatEngine: new ThreatEngine(ctx.dataDir, call.sessionId), onEvent: ctx.getActiveOnEvent(call.sessionId) } : {}),
    }),
  });
}

export const handleInboxRoutes: RouteHandler = async (method, url, req, res, ctx, role) => {
  if (url.pathname !== "/api/inbox" && !url.pathname.startsWith("/api/inbox/")) return false;
  const json = (status: number, data: unknown) => jsonResponse(res, status, data, req);
  if (role === "agent") { json(403, { error: "The inbox is the user's; only they read and answer it." }); return true; }

  if (method === "GET" && url.pathname === "/api/inbox") { json(200, listInbox()); return true; }

  const isAct = method === "POST" && url.pathname === "/api/inbox/act";
  const mutation = method === "POST" ? MUTATIONS[url.pathname] : undefined;
  if (!mutation && !isAct) return false;
  if (role !== "operator" && role !== "user") { json(403, { error: "Answering the inbox requires operator or user role" }); return true; }

  let id = "";
  let body: Record<string, unknown> | null = {};
  if (isAct || mutation?.action !== "read_all") {
    body = await safeParseBody(req);
    if (body === null) { json(400, { error: "Invalid JSON" }); return true; }
    id = typeof body.id === "string" ? body.id : "";
    if (!id) { json(400, { error: "id is required" }); return true; }
  }
  if (isAct) {
    const action = body.action;
    if (action !== "approve" && action !== "decline") { json(400, { error: "action must be approve or decline" }); return true; }
    const result = await act(ctx, id, action);
    if (!result.ok) { json(REFUSED_STATUS[result.refused], { error: REFUSED_TEXT[result.refused] }); return true; }
    const counts = action === "decline" ? broadcastChanged(ctx, "decline", id) : inboxStore().counts();
    json(200, { ...result, unread: counts.unread, needsYou: counts.needsYou });
    return true;
  }
  const store = inboxStore();
  if (!mutation!.apply(store, id)) { json(404, { error: `No inbox item ${id}` }); return true; }
  const frame = broadcastChanged(ctx, mutation!.action, id);
  json(200, { ok: true, unread: frame.unread, needsYou: frame.needsYou });
  return true;
};
