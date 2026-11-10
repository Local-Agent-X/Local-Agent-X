/**
 * A chat's own copy of its project, for the strip in its window (ADR 0007 §6,
 * agency/chat-own-copy.ts).
 *
 *   POST /api/work-claims/own-copy  {sessionId, action}
 *     "start" — move the chat to its own worktree of the project's repo
 *     "merge" — merge the copy back into the project's branch and end it
 *     "leave" — drop the copy without merging (its branch is kept if unmerged)
 *
 * `ownCopyView` is what GET /api/work-claims?session= adds for the chat: the
 * copy it has, and the other chats writing the same folder it does, which is
 * when a copy is worth offering.
 *
 * A chat in the middle of a turn is refused: its folder must not move under a
 * running agent.
 */
import { join } from "node:path";
import type { RouteHandler, ServerContext } from "../../server-context.js";
import { jsonResponse, safeParseBody } from "../../server-utils.js";
import { leaveOwnCopy, mergeOwnCopy, ownCopyOf, startOwnCopy } from "../../agency/chat-own-copy.js";
import { liveHolders } from "../../agency/work-claims.js";
import { locateInRepo } from "../../agency/repo-locate.js";
import { sessionProjectFolder } from "../../session/project-folder.js";
import { isPinnableSessionId } from "../../session/model-pin.js";

export interface OwnCopyView {
  /** The chat's copy, when it has one. */
  copy: { branch: string; baseBranch: string } | null;
  /** Other chats writing the very folder this chat writes, by name. */
  sharesFolderWith: string[];
}

function projectFolderOf(ctx: Pick<ServerContext, "sessionStore">, sessionId: string): string | undefined {
  const session = ctx.sessionStore.load(sessionId);
  return session ? sessionProjectFolder({ id: session.id, mode: session.mode, projectId: session.projectId, folder: session.folder }) : undefined;
}

export function ownCopyView(ctx: Pick<ServerContext, "sessionStore">, sessionId: string): OwnCopyView {
  const copy = ownCopyOf(sessionId);
  if (copy) return { copy: { branch: copy.branch, baseBranch: copy.baseBranch }, sharesFolderWith: [] };
  const folder = projectFolderOf(ctx, sessionId);
  const place = folder ? locateInRepo(join(folder, ".own-copy")) : null;
  if (!place || place.repoKey.startsWith("dir:")) return { copy: null, sharesFolderWith: [] };
  const mine = place.checkout.replace(/\\/g, "/").toLowerCase();
  const sharers = liveHolders(place.repoKey)
    .filter((h) => h.sessionId !== sessionId && h.state !== "recent" && h.checkout.replace(/\\/g, "/").toLowerCase() === mine)
    .map((h) => h.displayName);
  return { copy: null, sharesFolderWith: sharers };
}

function midTurn(sessionId: string): boolean {
  return liveHolders().some((h) => h.sessionId === sessionId && h.state === "active");
}

export const handleOwnCopyRoutes: RouteHandler = async (method, url, req, res, ctx) => {
  if (method !== "POST" || url.pathname !== "/api/work-claims/own-copy") return false;
  const json = (status: number, data: unknown) => jsonResponse(res, status, data, req);
  const body = await safeParseBody(req);
  const sessionId = body?.sessionId;
  if (!body || !isPinnableSessionId(sessionId)) { json(400, { error: "sessionId required" }); return true; }
  if (midTurn(sessionId)) { json(409, { error: "This chat is in the middle of a turn. Wait for it to finish, then try again." }); return true; }

  let result: Record<string, unknown>;
  if (body.action === "start") {
    const folder = projectFolderOf(ctx, sessionId);
    if (!folder) { json(400, { error: "This chat has no project folder to copy." }); return true; }
    const started = startOwnCopy(sessionId, folder);
    if (!started.ok) { json(409, { error: started.error }); return true; }
    result = { ok: true, branch: started.copy.branch, baseBranch: started.copy.baseBranch };
  } else if (body.action === "merge") {
    const merged = mergeOwnCopy(sessionId);
    if (!merged.merged) { json(409, { error: merged.error ?? "The copy could not be merged." }); return true; }
    result = { ok: true, files: merged.files, overlapNote: merged.overlapNote ?? "" };
  } else if (body.action === "leave") {
    result = { ok: true, ...leaveOwnCopy(sessionId) };
  } else {
    json(400, { error: "action must be start, merge or leave" }); return true;
  }
  try {
    const { broadcastAll } = await import("../../chat-ws/index.js");
    broadcastAll({ type: "work_claims_changed" });
  } catch { /* no socket server in tests */ }
  json(200, result);
  return true;
};
