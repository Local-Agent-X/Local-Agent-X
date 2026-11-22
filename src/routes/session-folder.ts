/**
 * GET /api/session-folder?session=<id> — the folder a chat works in.
 *
 * The chat's terminal opens there (public/js/terminal-panel.js): its own copy
 * of the project when it has one, else its project folder; an App IDE
 * session's app folder. `{ folder: null }` for a chat with none, which opens
 * in the app's own folder as every terminal used to.
 *
 * Read from the session's record, so it answers between turns and after a
 * restart, when no work root is stamped. Reading it stamps nothing.
 */
import type { RouteHandler } from "../server-context.js";
import { isValidSessionId, jsonResponse } from "../server-utils.js";
import { sessionFolderFor } from "../session/project-folder.js";

export const handleSessionFolderRoute: RouteHandler = async (method, url, req, res, ctx) => {
  if (method !== "GET" || url.pathname !== "/api/session-folder") return false;
  const id = url.searchParams.get("session") ?? "";
  if (!isValidSessionId(id)) {
    jsonResponse(res, 400, { error: "Invalid session ID" }, req);
    return true;
  }
  const session = ctx.sessionStore.load(id);
  const folder = sessionFolderFor({ id, mode: session?.mode, projectId: session?.projectId, folder: session?.folder });
  jsonResponse(res, 200, { folder: folder ?? null }, req);
  return true;
};
