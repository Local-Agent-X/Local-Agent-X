/**
 * POST /api/sessions/fork — a new session holding the source transcript up to
 * one message. With mode "code" the fork is a code session (session/mode.ts)
 * in the source's project folder: how a chat that turned into coding work
 * continues under the code prompt profile, since a session's mode is fixed at
 * creation and cannot be switched mid-conversation.
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import { randomBytes } from "node:crypto";
import { isHarnessRow } from "../harness-rows.js";
import type { ServerContext } from "../server-context.js";
import { isValidSessionId, readBody, jsonResponse } from "../server-utils.js";
import { parseChatMode } from "../session/mode.js";

export async function handleSessionFork(req: IncomingMessage, res: ServerResponse, ctx: ServerContext): Promise<void> {
  const json = (status: number, data: unknown) => jsonResponse(res, status, data, req);
  let body: Record<string, unknown>;
  try { body = JSON.parse(await readBody(req)); } catch { json(400, { error: "Invalid JSON" }); return; }
  const sourceId = String(body.sessionId || "");
  const atIndex = typeof body.atIndex === "number" ? body.atIndex : -1;
  if (!sourceId || !isValidSessionId(sourceId)) { json(400, { error: "Invalid session ID" }); return; }
  // Fork persists a slice of the transcript — flush the bridge so the fork
  // can't miss the source's last turn.
  await ctx.flushSession(sourceId);
  const source = ctx.getOrCreateSession(sourceId);
  if (atIndex < 0 || atIndex >= source.messages.length) { json(400, { error: "Invalid message index" }); return; }
  const forkId = `fork-${randomBytes(8).toString("hex")}`;
  // Never end a fork on a harness row: a nudge is not a message the user
  // could have clicked, and a fork ending there would open with the
  // harness's own instruction as its last turn.
  let sliceEnd = atIndex + 1;
  while (sliceEnd > 0 && isHarnessRow(source.messages[sliceEnd - 1])) sliceEnd--;
  const forkedMessages = source.messages.slice(0, sliceEnd);
  const mode = parseChatMode(body.mode);
  const forkSession = {
    id: forkId, title: `${mode === "code" ? "Code" : "Fork"}: ${source.title}`,
    messages: JSON.parse(JSON.stringify(forkedMessages)),
    createdAt: Date.now(), updatedAt: Date.now(),
    forkedFrom: sourceId,
    forkAtIndex: atIndex,
    ...(mode === "code" ? { mode } : {}),
    ...(source.projectId ? { projectId: source.projectId } : {}),
  };
  ctx.saveSession(forkSession);
  json(200, { ok: true, forkId, title: forkSession.title, messageCount: forkedMessages.length, mode: mode ?? "chat", projectId: source.projectId ?? null });
}
