/**
 * Sessions made from another session: a fork of its transcript
 * (sessions-fork.ts), a chat a session_start offer started (sessions-start.ts),
 * and the fork tree the sidebar draws. Out of sessions.ts's route table, which
 * owns reading and editing a session.
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import type { ServerContext } from "../server-context.js";
import { jsonResponse } from "../server-utils.js";
import { handleSessionFork } from "./sessions-fork.js";
import { handleSessionStart } from "./sessions-start.js";

export async function handleSessionBranchRoutes(
  method: string, url: URL, req: IncomingMessage, res: ServerResponse, ctx: ServerContext,
): Promise<boolean> {
  if (method === "POST" && url.pathname === "/api/sessions/fork") {
    await handleSessionFork(req, res, ctx);
    return true;
  }
  if (method === "POST" && url.pathname === "/api/sessions/start") {
    await handleSessionStart(req, res, ctx);
    return true;
  }
  if (method === "GET" && url.pathname === "/api/sessions/forks") {
    const json = (status: number, data: unknown) => jsonResponse(res, status, data, req);
    const sourceId = url.searchParams.get("sessionId") || "";
    if (!sourceId) { json(400, { error: "sessionId required" }); return true; }
    const forks: Array<{ id: string; title: string; forkAtIndex: number; createdAt: number }> = [];
    for (const meta of ctx.sessionStore.list()) {
      const s = ctx.sessionStore.load(meta.id);
      if (s && s.forkedFrom === sourceId) {
        forks.push({ id: s.id, title: s.title, forkAtIndex: s.forkAtIndex || 0, createdAt: s.createdAt });
      }
    }
    const thisSession = ctx.sessionStore.load(sourceId);
    json(200, { forks, parent: thisSession?.forkedFrom || null });
    return true;
  }
  return false;
}
