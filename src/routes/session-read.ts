import type { IncomingMessage, ServerResponse } from "node:http";
import type { ServerContext } from "../server-context.js";
import { isValidSessionId, jsonResponse } from "../server-utils.js";
import { exportSession } from "../session/export.js";
import { loadSessionPage } from "../progressive-loader.js";

/**
 * Reading one stored session out: GET /api/sessions/:id/export and
 * GET /api/sessions/:id/messages (a page, newest first; the fork into Code
 * mode reads its new session back this way). Both read the SessionStore after
 * the session's queued write lands (the session-helpers rule for readers);
 * they used to open `.json` files no store writes, and answered 404 always.
 */
export async function handleSessionReadRoutes(
  method: string,
  url: URL,
  req: IncomingMessage,
  res: ServerResponse,
  ctx: ServerContext,
): Promise<boolean> {
  if (method !== "GET" || !url.pathname.startsWith("/api/sessions/")) return false;
  const reading = url.pathname.endsWith("/export") ? "export" : url.pathname.endsWith("/messages") ? "messages" : null;
  if (!reading) return false;
  const json = (status: number, data: unknown) => jsonResponse(res, status, data, req);
  const id = url.pathname.split("/")[3];
  if (!isValidSessionId(id)) { json(400, { error: "Invalid session ID" }); return true; }
  await ctx.flushSession(id);

  if (reading === "export") {
    const session = ctx.sessionStore.load(id);
    if (!session) { json(404, { error: `Session not found: ${id}` }); return true; }
    const format = (url.searchParams.get("format") || "json") as "json" | "markdown";
    json(200, exportSession(session as unknown as Parameters<typeof exportSession>[0], format));
    return true;
  }
  const session = ctx.sessionStore.loadForUI(id);
  if (!session) { json(404, { error: `Session not found: ${id}` }); return true; }
  const page = parseInt(url.searchParams.get("page") || "0");
  const pageSize = parseInt(url.searchParams.get("pageSize") || "50");
  json(200, loadSessionPage(session, page, pageSize));
  return true;
}
