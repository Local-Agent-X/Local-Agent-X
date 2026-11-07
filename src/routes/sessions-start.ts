/**
 * POST /api/sessions/start — the user tapped a session_start offer: a new chat,
 * linked to the one that offered it, whose first message is the brief. It
 * answers once the chat is saved and starts the chat's first turn without
 * waiting for it (session/linked-chat.ts); the starting chat hears when the
 * turn is done.
 *
 * The offer came from a tool call, so its title and brief are bounded here as
 * the tool bounds them, and the starting chat must exist. A second tap on the
 * same offer (both clients, a double tap) returns the chat the first one
 * started instead of starting another. The new chat works where the starting
 * one does: started from a code session it is a code session on the same
 * folder, as Claude Code's own sessions are.
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import { createHash, randomBytes } from "node:crypto";
import type { ServerContext } from "../server-context.js";
import { isValidSessionId, readBody, jsonResponse } from "../server-utils.js";
import { sessionOfferOf } from "../tools/session-start-tool.js";
import { runLinkedChat } from "../session/linked-chat.js";
import { sessionModeOf } from "../session/mode.js";
import { createLogger } from "../logger.js";

const logger = createLogger("routes.sessions-start");

/** Offers already started: offer key → the chat it started, for 24 hours. */
const started = new Map<string, { sessionId: string; at: number }>();
const STARTED_TTL_MS = 24 * 60 * 60 * 1000;

function offerKey(originId: string, title: string, brief: string): string {
  return createHash("sha256").update(`${originId}\n${title}\n${brief}`).digest("hex");
}

export async function handleSessionStart(req: IncomingMessage, res: ServerResponse, ctx: ServerContext): Promise<void> {
  const json = (status: number, data: unknown) => jsonResponse(res, status, data, req);
  let body: Record<string, unknown>;
  try { body = JSON.parse(await readBody(req)); } catch { json(400, { error: "Invalid JSON" }); return; }
  const originId = String(body.sessionId || "");
  if (!originId || !isValidSessionId(originId)) { json(400, { error: "Invalid session ID" }); return; }
  const offer = sessionOfferOf(body);
  if (!offer) { json(400, { error: "A title and a brief are required." }); return; }
  const origin = ctx.sessionStore.load(originId);
  if (!origin) { json(404, { error: "The chat that offered this is gone." }); return; }

  const now = Date.now();
  for (const [k, v] of started) if (now - v.at > STARTED_TTL_MS) started.delete(k);
  const key = offerKey(originId, offer.title, offer.brief);
  const prior = started.get(key);
  if (prior) { json(200, { ok: true, sessionId: prior.sessionId, title: offer.title, alreadyStarted: true }); return; }

  const sessionId = `task-${randomBytes(8).toString("hex")}`;
  started.set(key, { sessionId, at: now });
  await ctx.saveSession({
    id: sessionId, title: offer.title, messages: [], createdAt: now, updatedAt: now,
    startedFrom: originId,
    // Where the starting chat works, this one works: a code session's mode and
    // project (its folder), a chat's bound app folder.
    ...(sessionModeOf(origin) === "code" ? { mode: "code" as const } : {}),
    ...(origin.projectId ? { projectId: origin.projectId } : {}),
    ...(origin.folder ? { folder: origin.folder } : {}),
  });
  json(200, { ok: true, sessionId, title: offer.title });
  void runLinkedChat(ctx, { originId, originTitle: origin.title, sessionId, title: offer.title, brief: offer.brief, mode: sessionModeOf(origin) })
    .catch((e) => logger.warn(`[sessions-start] ${sessionId}: ${(e as Error).message}`));
}

/** Test seam: forget which offers were started. */
export function _resetStartedOffersForTest(): void {
  started.clear();
}
