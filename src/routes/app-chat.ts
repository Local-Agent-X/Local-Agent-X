// An app's conversations with the user's agents, over HTTP.
//
// On the app's own listener (server/agent-origin.ts admits these with the
// app's chat capability and nothing else):
//   POST /api/app-chat/<app>/threads/<thread>/messages  { message, persona? }
//        → text/event-stream of AppChatEvent (server/app-chat-turn.ts)
//   GET  /api/app-chat/<app>/threads/<thread>/messages  → { messages: [{ role, text }] }
//   POST /api/app-chat/<app>/threads/<thread>/stop      → { stopped }
//
// On the UI origin, for the Apps page (the operator only: the agent writes the
// apps, so it is never the one who reads or clears the user's answers):
//   GET  /api/app-chat-grants                 → { grants: [{ appId, answer, at }] }
//   POST /api/app-chat-grants/<app>/forget    → take the user's answer back
//
// Every app call needs the user's yes for that app. Until they have answered,
// the call is refused with code "needs_approval" and a card waits in the inbox
// (inbox/app-chat-approval.ts); after a no, with code "denied".
//
// The path is deliberately not under /api/apps: that prefix is one the phone's
// tunnel may reach with the operator's authority (broker-transport/device-paths.ts).

import type { IncomingMessage, ServerResponse } from "node:http";
import type { RouteHandler, ServerContext } from "../server-context.js";
import { jsonResponse, safeParseBody } from "../server-utils.js";
import { appChatAnswer, forgetAppChatAnswer, listAppChatGrants } from "../app-runtime/chat-grants.js";
import { inboxAppChatRequest } from "../inbox/app-chat-approval.js";
import { projectSessionForUI } from "../memory/session-message-log.js";
import {
  appChatSessionId, claimAppChatTurn, isAppChatThread, readAppChatMessage, runAppChatTurn, stopAppChatTurn,
  type AppChatEvent, type AppChatRefusal,
} from "../server/app-chat-turn.js";

export const APP_CHAT_PREFIX = "/api/app-chat/";
const APP_CHAT_PATH = /^\/api\/app-chat\/([a-zA-Z0-9_-]{1,64})\/threads\/([^/]+)\/(messages|stop)$/;
const HEARTBEAT_MS = 15_000;

function refuse(res: ServerResponse, req: IncomingMessage, refusal: AppChatRefusal): true {
  jsonResponse(res, refusal.status, { error: refusal.error, code: refusal.code }, req);
  return true;
}

/** The request came from a page of this app's own origin: a browser names the
 *  origin on every POST and says how the request relates to the page. */
function fromOwnPage(method: string, req: IncomingMessage, ownOrigins: readonly string[]): boolean {
  const site = req.headers["sec-fetch-site"];
  if (site !== undefined && site !== "same-origin") return false;
  const origin = req.headers.origin;
  if (method === "GET") return origin === undefined || ownOrigins.includes(origin);
  return typeof origin === "string" && ownOrigins.includes(origin);
}

/** The user's answer for this app, as a refusal when it is not a yes. Asking
 *  posts the card once; a repeat while it waits changes nothing. */
function grantRefusal(appId: string): AppChatRefusal | null {
  const answer = appChatAnswer(appId);
  if (answer === "granted") return null;
  if (answer === "denied") {
    return { status: 403, code: "denied", error: "The user declined to let this app talk to their agents. They can change that on the Apps page of Local Agent X." };
  }
  inboxAppChatRequest(appId);
  return { status: 403, code: "needs_approval", error: "The user has not yet allowed this app to talk to their agents. A request is waiting in the Local Agent X inbox; try again once they approve it." };
}

function threadHistory(ctx: ServerContext, appId: string, thread: string): Array<{ role: "user" | "assistant"; text: string }> {
  const session = ctx.sessionStore.load(appChatSessionId(appId, thread));
  if (!session) return [];
  const out: Array<{ role: "user" | "assistant"; text: string }> = [];
  for (const message of projectSessionForUI(session).messages) {
    if (message.role !== "user" && message.role !== "assistant") continue;
    const text = typeof message.content === "string" ? message.content : "";
    if (text) out.push({ role: message.role, text });
  }
  return out;
}

async function streamTurn(req: IncomingMessage, res: ServerResponse, ctx: ServerContext, appId: string, thread: string): Promise<true> {
  const body = readAppChatMessage(await safeParseBody(req));
  if ("status" in body) return refuse(res, req, body);
  const release = claimAppChatTurn(appId, appChatSessionId(appId, thread));
  if (typeof release !== "function") return refuse(res, req, release);

  res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive", "X-Content-Type-Options": "nosniff" });
  const heartbeat = setInterval(() => { if (!res.destroyed) res.write(": heartbeat\n\n"); }, HEARTBEAT_MS);
  // A page that goes away leaves its turn running; what it missed is in the
  // thread's history.
  const send = (event: AppChatEvent) => { if (!res.writableEnded && !res.destroyed) res.write(`data: ${JSON.stringify(event)}\n\n`); };
  try {
    await runAppChatTurn(ctx, { appId, thread, ...body }, send);
  } finally {
    clearInterval(heartbeat);
    release();
    if (!res.writableEnded) res.end();
  }
  return true;
}

/**
 * The app's side, called by the app's own listener once the app's chat
 * capability has checked out. `appId` is the listener's app, `ownOrigins` the
 * origins a page of it has.
 */
export async function handleAppChatCall(
  method: string, url: URL, req: IncomingMessage, res: ServerResponse, ctx: ServerContext, appId: string, ownOrigins: readonly string[],
): Promise<boolean> {
  const match = url.pathname.match(APP_CHAT_PATH);
  if (!match || match[1] !== appId) return false;
  const [, , thread, call] = match;
  if (!fromOwnPage(method, req, ownOrigins)) {
    return refuse(res, req, { status: 403, code: "wrong_origin", error: "This call is only for the app's own page." });
  }
  if (!isAppChatThread(thread)) {
    return refuse(res, req, { status: 400, code: "bad_thread", error: "A thread name is 1 to 32 lowercase letters, digits, hyphens or underscores, starting with a letter or digit." });
  }
  const isRead = method === "GET" && call === "messages";
  const isSend = method === "POST" && call === "messages";
  const isStop = method === "POST" && call === "stop";
  if (!isRead && !isSend && !isStop) return false;
  const refusal = grantRefusal(appId);
  if (refusal) return refuse(res, req, refusal);
  if (isRead) { jsonResponse(res, 200, { messages: threadHistory(ctx, appId, thread) }, req); return true; }
  if (isStop) { jsonResponse(res, 200, { stopped: stopAppChatTurn(appId, thread) }, req); return true; }
  return streamTurn(req, res, ctx, appId, thread);
}

const GRANT_FORGET_PATH = /^\/api\/app-chat-grants\/([a-zA-Z0-9_-]{1,64})\/forget$/;

/** The Apps page's side: which apps may talk to the user's agents, and taking
 *  an answer back. */
export const handleAppChatGrantRoutes: RouteHandler = async (method, url, req, res, ctx, role) => {
  if (url.pathname !== "/api/app-chat-grants" && !url.pathname.startsWith("/api/app-chat-grants/")) return false;
  const json = (status: number, data: unknown) => jsonResponse(res, status, data, req);
  if (role !== "operator") { json(403, { error: "Only the operator decides which apps may talk to their agents." }); return true; }
  if (method === "GET" && url.pathname === "/api/app-chat-grants") { json(200, { grants: listAppChatGrants() }); return true; }
  const forget = method === "POST" ? url.pathname.match(GRANT_FORGET_PATH) : null;
  if (!forget) return false;
  const forgotten = forgetAppChatAnswer(forget[1]);
  if (forgotten) ctx.broadcastAll({ type: "settings_changed", settings: { appChatGrants: true } });
  json(200, { ok: true, forgotten });
  return true;
};
