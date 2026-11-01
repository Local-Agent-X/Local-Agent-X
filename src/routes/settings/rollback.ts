import type { RouteHandler } from "../../server-context.js";
import { jsonResponse, readBody } from "../../server-utils.js";

/**
 * Undo of file changes (autonomy/rollback.ts): Settings → Rollback lists the
 * captures and undoes one call; the chat's Undo under a reply rewinds every
 * file changed from that request on (autonomy/rollback-rewind.ts). These move
 * files, not settings, so like /api/trash/restore they broadcast nothing.
 */
export const handleRollbackRoutes: RouteHandler = async (method, url, req, res) => {
  const json = (status: number, data: unknown) => jsonResponse(res, status, data, req);

  if (method === "GET" && url.pathname === "/api/rollback/list") {
    const { listRollbacks } = await import("../../autonomy/rollback.js");
    const limit = Math.min(parseInt(url.searchParams.get("limit") || "50", 10) || 50, 200);
    json(200, { entries: listRollbacks(limit) }); return true;
  }
  if (method === "POST" && url.pathname === "/api/rollback/undo") {
    const body = await readBody(req);
    const { toolCallId } = JSON.parse(body);
    if (typeof toolCallId !== "string" || !toolCallId) { json(400, { error: "toolCallId required" }); return true; }
    const { restoreRollback } = await import("../../autonomy/rollback.js");
    const result = await restoreRollback(toolCallId);
    json(result.ok ? 200 : 400, result); return true;
  }
  // `preview` answers what a rewind would touch, so the chat can ask first
  // when later requests' changes would go too.
  if (method === "POST" && url.pathname === "/api/rollback/rewind") {
    const body = await readBody(req);
    const { sessionId, opId, preview } = JSON.parse(body);
    if (typeof sessionId !== "string" || !sessionId || typeof opId !== "string" || !opId) {
      json(400, { error: "sessionId and opId required" }); return true;
    }
    const { planRewind, rewindToBeforeOp } = await import("../../autonomy/rollback-rewind.js");
    if (preview === true) {
      const plan = planRewind(sessionId, opId);
      json(plan ? 200 : 404, plan ?? { error: "no file changes from that request are on record" }); return true;
    }
    const result = await rewindToBeforeOp(sessionId, opId);
    json(result.ok ? 200 : 404, result); return true;
  }
  return false;
};
