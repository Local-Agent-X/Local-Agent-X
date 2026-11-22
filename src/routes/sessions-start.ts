/**
 * POST /api/sessions/start — the user tapped a session_start offer: a new chat,
 * linked to the one that offered it, whose first message is the brief. It
 * answers once the chat is saved and starts the chat's first turn without
 * waiting for it (session/start-linked-chat.ts); the starting chat hears when
 * the turn is done.
 *
 * The offer came from a tool call, so its title, brief and folder are bounded
 * here as the tool bounds them, and the starting chat must exist. A second tap
 * on the same offer (both clients, a double tap) returns the chat the first one
 * started instead of starting another. The new chat works where the starting
 * one does, or in the new project folder the offer names.
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import { createHash } from "node:crypto";
import type { ServerContext } from "../server-context.js";
import { isValidSessionId, readBody, jsonResponse } from "../server-utils.js";
import { sessionOfferOf } from "../tools/session-start-tool.js";
import { StartChatError, startLinkedChat, type StartedChat } from "../session/start-linked-chat.js";

/** Offers already started: offer key → the chat it started, for 24 hours. */
const started = new Map<string, { sessionId: string; at: number }>();
const STARTED_TTL_MS = 24 * 60 * 60 * 1000;
/** Offers whose chat is being created right now. */
const pending = new Map<string, Promise<StartedChat>>();

function offerKey(originId: string, title: string, brief: string, folder = ""): string {
  return createHash("sha256").update(`${originId}\n${title}\n${brief}\n${folder}`).digest("hex");
}

export async function handleSessionStart(req: IncomingMessage, res: ServerResponse, ctx: ServerContext): Promise<void> {
  const json = (status: number, data: unknown) => jsonResponse(res, status, data, req);
  let body: Record<string, unknown>;
  try { body = JSON.parse(await readBody(req)); } catch { json(400, { error: "Invalid JSON" }); return; }
  const originId = String(body.sessionId || "");
  if (!originId || !isValidSessionId(originId)) { json(400, { error: "Invalid session ID" }); return; }
  const offer = sessionOfferOf(body);
  if (!offer) { json(400, { error: "A title and a brief are required." }); return; }
  if (!ctx.sessionStore.load(originId)) { json(404, { error: "The chat that offered this is gone." }); return; }

  const now = Date.now();
  for (const [k, v] of started) if (now - v.at > STARTED_TTL_MS) started.delete(k);
  const key = offerKey(originId, offer.title, offer.brief, offer.folder);
  const inFlight = pending.get(key);
  const prior = started.get(key) ?? (inFlight ? await inFlight.then((c) => ({ sessionId: c.sessionId }), () => undefined) : undefined);
  if (prior) { json(200, { ok: true, sessionId: prior.sessionId, title: offer.title, alreadyStarted: true }); return; }

  // Held before the first await, so a second tap arriving meanwhile waits on
  // this one instead of starting another chat.
  const starting = startLinkedChat(ctx, { originId, ...offer });
  pending.set(key, starting);
  try {
    const chat = await starting;
    started.set(key, { sessionId: chat.sessionId, at: now });
    json(200, { ok: true, sessionId: chat.sessionId, title: chat.title, ...(chat.folder ? { folder: chat.folder } : {}) });
  } catch (e) {
    if (e instanceof StartChatError) { json(400, { error: e.message }); return; }
    throw e;
  } finally {
    pending.delete(key);
  }
}

/** Test seam: forget which offers were started. */
export function _resetStartedOffersForTest(): void {
  started.clear();
}
