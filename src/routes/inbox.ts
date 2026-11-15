// The user inbox over HTTP: the bell's list and the user's answers to it.
//
// GET  /api/inbox               → { items, unread, needsYou }
// POST /api/inbox/read          { id } → mark one read
// POST /api/inbox/read-all      → mark every visible item read
// POST /api/inbox/dismiss       { id } → hide it (soft; see src/inbox/store.ts)
// POST /api/inbox/resolve       { id } → the user dealt with it
// POST /api/inbox/act           { id, action: "approve" | "decline" } → answer
//                               an approval (src/inbox/approvals.ts)
// POST /api/inbox/reply         { id, text } → open (or continue) a chat about
//                               the item, the user's words first (src/inbox/reply.ts)
//
// Every mutation broadcasts `inbox_changed` with the new counts so every open
// tab redraws. The phone's inbox frames (src/chat-ws/inbox-frames.ts) land on
// the same two functions, `mutateInbox` and `actOnInbox`: one path answers an
// item whichever screen the user is on. The agent principal is refused
// outright: the inbox is the user's channel, and an agent that could dismiss or
// resolve items could hide what it was refused, or approve its own parked calls.

import type { RouteHandler, ServerContext } from "../server-context.js";
import { jsonResponse, safeParseBody } from "../server-utils.js";
import { inboxStore, listInbox, toInboxView, type InboxFrame } from "../inbox/index.js";
import { approveInboxItem, declineInboxItem, INBOX_REFUSAL_TEXT, type InboxActResult } from "../inbox/approvals.js";
import { answerLiveApproval, liveApprovalOf } from "../inbox/live-approval.js";
import { getApprovalManager } from "../approval-manager.js";
import { dispatchApprovedCall, resolveApprovedTool } from "../tool-execution/index.js";
import { SecurityLayer } from "../security/index.js";
import { loadFileAccessModeAtLeast } from "../security/layer/index.js";
import { ThreatEngine } from "../threat/threat-engine.js";
import { replyToInboxItem, type InboxReplyResult } from "../inbox/reply.js";
import { getChatHandler } from "../chat-ws/chat-handler.js";
import { recordExternalIngestion } from "../data-lineage/external.js";
import { createLogger } from "../logger.js";

const logger = createLogger("routes.inbox");

type ChangedFrame = Extract<InboxFrame, { type: "inbox_changed" }>;
/** The bell's plain answers: everything but Approve and Decline. */
export type InboxMutation = Exclude<ChangedFrame["action"], "approve" | "decline">;

const MUTATION_PATHS: Record<string, InboxMutation> = {
  "/api/inbox/read": "read",
  "/api/inbox/read-all": "read_all",
  "/api/inbox/dismiss": "dismiss",
  "/api/inbox/resolve": "resolve",
};

const REFUSED_STATUS = { missing: 404, "not-approval": 400, answered: 409 } as const;

/** Tell every tab and device. The frame carries the item's new state when the
 *  answer concerned one item that is still visible (a dismissed one is gone). */
function broadcastChanged(ctx: ServerContext, action: ChangedFrame["action"], id?: string): ChangedFrame {
  const store = inboxStore();
  const stored = id ? store.get(id) : undefined;
  const item = stored && stored.dismissedAt === undefined ? toInboxView(stored) : undefined;
  const frame: ChangedFrame = { type: "inbox_changed", action, ...(id ? { id } : {}), ...(item ? { item } : {}), ...store.counts() };
  ctx.broadcastAll(frame);
  return frame;
}

/** Apply one of the bell's plain answers and broadcast it. Null when no item
 *  has that id (`read_all` needs none). */
export function mutateInbox(ctx: ServerContext, action: InboxMutation, id: string): ChangedFrame | null {
  const store = inboxStore();
  if (action === "read_all") { store.markAllRead(); return broadcastChanged(ctx, action); }
  const applied = action === "read" ? store.markRead(id) : action === "dismiss" ? store.dismiss(id) : store.resolve(id);
  return applied ? broadcastChanged(ctx, action, id) : null;
}

/** Answer an approval. Approve runs the stored call as the unattended run
 *  would have: its session, role and context, the workspace file-access floor
 *  every unattended run gets (cron runner, ops tools), that session's threat
 *  state. Decline runs nothing. Either answer is broadcast once claimed. */
export async function actOnInbox(ctx: ServerContext, id: string, action: "approve" | "decline"): Promise<InboxActResult> {
  // A copy of a chat's live card answers that card; nothing runs from here
  // (the card's own turn runs the call on the answer).
  if (liveApprovalOf(id)) {
    return answerLiveApproval(id, action === "approve",
      (approvalId, approved) => getApprovalManager().resolveApproval(approvalId, approved),
      () => broadcastChanged(ctx, action, id));
  }
  if (action === "decline") {
    const result = declineInboxItem(id);
    if (result.ok) broadcastChanged(ctx, "decline", id);
    return result;
  }
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

/** Reply to an item: open (or continue) the chat about it, and tell every tab
 *  the item now links there. One function for the bell and the phone. */
export async function replyFromInbox(ctx: ServerContext, id: string, text: string): Promise<InboxReplyResult> {
  const result = await replyToInboxItem(id, text, {
    chatExists: (sessionId) => ctx.sessionStore.load(sessionId) !== null,
    createChat: async ({ id: sessionId, title }) => {
      const now = Date.now();
      await ctx.saveSession({ id: sessionId, title, messages: [], createdAt: now, updatedAt: now });
    },
    send: (sessionId, message) => {
      const handler = getChatHandler();
      if (!handler) { logger.warn(`[inbox] reply chat ${sessionId}: the chat runner is not up`); return; }
      void Promise.resolve(handler(sessionId, message, [], { channel: "web" }))
        .catch((e) => logger.warn(`[inbox] reply chat ${sessionId}: ${(e as Error).message}`));
    },
    markExternal: (sessionId) => recordExternalIngestion(sessionId),
  });
  if (result.ok) broadcastChanged(ctx, "read", id);
  return result;
}

export const handleInboxRoutes: RouteHandler = async (method, url, req, res, ctx, role) => {
  if (url.pathname !== "/api/inbox" && !url.pathname.startsWith("/api/inbox/")) return false;
  const json = (status: number, data: unknown) => jsonResponse(res, status, data, req);
  if (role === "agent") { json(403, { error: "The inbox is the user's; only they read and answer it." }); return true; }

  if (method === "GET" && url.pathname === "/api/inbox") { json(200, listInbox()); return true; }

  const isAct = method === "POST" && url.pathname === "/api/inbox/act";
  const isReply = method === "POST" && url.pathname === "/api/inbox/reply";
  const mutation = method === "POST" ? MUTATION_PATHS[url.pathname] : undefined;
  if (!mutation && !isAct && !isReply) return false;
  if (role !== "operator" && role !== "user") { json(403, { error: "Answering the inbox requires operator or user role" }); return true; }

  let id = "";
  let body: Record<string, unknown> | null = {};
  if (isAct || isReply || mutation !== "read_all") {
    body = await safeParseBody(req);
    if (body === null) { json(400, { error: "Invalid JSON" }); return true; }
    id = typeof body.id === "string" ? body.id : "";
    if (!id) { json(400, { error: "id is required" }); return true; }
  }
  if (isReply) {
    const result = await replyFromInbox(ctx, id, typeof body.text === "string" ? body.text : "");
    if (!result.ok) { json(result.refused === "missing" ? 404 : 400, { error: result.refused === "missing" ? `No inbox item ${id}` : "Write something to reply." }); return true; }
    json(200, result);
    return true;
  }
  if (isAct) {
    const action = body.action;
    if (action !== "approve" && action !== "decline") { json(400, { error: "action must be approve or decline" }); return true; }
    const result = await actOnInbox(ctx, id, action);
    if (!result.ok) { json(REFUSED_STATUS[result.refused], { error: INBOX_REFUSAL_TEXT[result.refused] }); return true; }
    json(200, { ...result, ...inboxStore().counts() });
    return true;
  }
  const frame = mutateInbox(ctx, mutation!, id);
  if (!frame) { json(404, { error: `No inbox item ${id}` }); return true; }
  json(200, { ok: true, unread: frame.unread, needsYou: frame.needsYou });
  return true;
};
