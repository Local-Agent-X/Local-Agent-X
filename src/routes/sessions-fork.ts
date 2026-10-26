/**
 * POST /api/sessions/fork — a new session holding the source transcript up to
 * one message. With mode "code" the fork is a code session (session/mode.ts)
 * in the source's project folder: how a chat that turned into coding work
 * continues under the code prompt profile, since a session's mode is fixed at
 * creation and cannot be switched mid-conversation.
 *
 * With a `handoff` ({ folder, brief }, from the agent's code_handoff offer) the
 * code session opens on the repo the chat worked in, as that folder's
 * code-folder project, and starts from the brief the agent wrote instead of the
 * whole chat: the goal, what is done and left, decisions and constraints, not
 * the hundreds of turns (and an earlier compaction) that led there.
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import { randomBytes } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { relative, resolve, isAbsolute } from "node:path";
import { isHarnessRow } from "../harness-rows.js";
import type { ServerContext } from "../server-context.js";
import { isValidSessionId, readBody, jsonResponse } from "../server-utils.js";
import { parseChatMode } from "../session/mode.js";
import { codeSessionFolder } from "../session/code-work-root.js";
import { codeFolderProject } from "./agents/projects.js";

const MAX_BRIEF_BYTES = 200 * 1024;

/** The handoff's folder and brief text, or why it cannot be used. The brief
 *  must be a file inside the folder: the offer came from a tool call, so its
 *  paths are checked here rather than trusted. */
function readHandoff(raw: unknown): { folder: string; brief: string; briefPath: string } | { error: string } {
  const h = (raw ?? {}) as { folder?: unknown; brief?: unknown };
  const folder = codeSessionFolder(typeof h.folder === "string" ? h.folder : undefined);
  if (!folder) return { error: "The handoff folder is not a folder on this computer." };
  const briefPath = typeof h.brief === "string" ? resolve(folder, h.brief) : "";
  const rel = relative(folder, briefPath);
  if (!briefPath || rel.startsWith("..") || isAbsolute(rel)) return { error: "The handoff brief must be a file inside the folder." };
  try {
    if (!statSync(briefPath).isFile() || statSync(briefPath).size > MAX_BRIEF_BYTES) return { error: "The handoff brief is missing or too large." };
    return { folder, briefPath, brief: readFileSync(briefPath, "utf-8") };
  } catch {
    return { error: "The handoff brief could not be read." };
  }
}

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
  const mode = parseChatMode(body.mode);
  const handoff = mode === "code" && body.handoff !== undefined ? readHandoff(body.handoff) : null;
  if (handoff && "error" in handoff) { json(400, { error: handoff.error }); return; }
  const forkId = `fork-${randomBytes(8).toString("hex")}`;
  // Never end a fork on a harness row: a nudge is not a message the user
  // could have clicked, and a fork ending there would open with the
  // harness's own instruction as its last turn.
  let sliceEnd = atIndex + 1;
  while (sliceEnd > 0 && isHarnessRow(source.messages[sliceEnd - 1])) sliceEnd--;
  // A handoff opens on the brief, as the leading system row compaction uses.
  const forkedMessages = handoff
    ? [{ role: "system", content: `[HANDOFF from the chat "${source.title}" — the brief below is where this work stands; it is also at ${handoff.briefPath}]\n${handoff.brief}\n[END HANDOFF]` }]
    : source.messages.slice(0, sliceEnd);
  const projectId = handoff ? (await codeFolderProject(handoff.folder, ctx.projectStore)).id : source.projectId;
  const forkSession = {
    id: forkId, title: `${mode === "code" ? "Code" : "Fork"}: ${source.title}`,
    messages: JSON.parse(JSON.stringify(forkedMessages)),
    createdAt: Date.now(), updatedAt: Date.now(),
    forkedFrom: sourceId,
    forkAtIndex: atIndex,
    ...(mode === "code" ? { mode } : {}),
    ...(projectId ? { projectId } : {}),
  };
  ctx.saveSession(forkSession);
  json(200, { ok: true, forkId, title: forkSession.title, messageCount: forkedMessages.length, mode: mode ?? "chat", projectId: projectId ?? null });
}
