/**
 * The memory change log in Settings (memory/fact-events.ts): what changed,
 * who changed it and why, and Undo.
 *
 *   GET  /api/memory/changes?limit=&before=&q=   newest first
 *   POST /api/memory/changes/:id/undo            operator only
 */
import type { RouteHandler } from "../server-context.js";
import { jsonResponse } from "../server-utils.js";
import type { FactEvent } from "../memory/fact-events.js";

/** What the Settings list shows for one change. */
export function changeView(e: FactEvent): Record<string, unknown> {
  const text = (e.after?.content ?? e.before?.content ?? null) as string | null;
  const was = e.op === "change" && e.before && e.after && e.before.content !== e.after.content ? e.before.content : null;
  return {
    id: e.id,
    factId: e.factId,
    at: e.at,
    op: e.op,
    actor: e.actor ?? "unknown",
    reason: e.reason,
    text,
    was,
    undone: e.undoneBy != null,
    // A fact erased at the user's request keeps no text to bring back.
    undoable: e.undoneBy == null && !(e.op === "delete" && !e.before),
  };
}

export const handleMemoryChangeRoutes: RouteHandler = async (method, url, req, res, ctx, requestRole) => {
  const json = (status: number, data: unknown) => jsonResponse(res, status, data, req);

  if (method === "GET" && url.pathname === "/api/memory/changes") {
    const limit = Math.min(200, Math.max(1, parseInt(url.searchParams.get("limit") || "50", 10) || 50));
    const before = parseInt(url.searchParams.get("before") || "", 10);
    const q = url.searchParams.get("q")?.trim() || undefined;
    const items = ctx.memoryIndex.memoryChanges({ limit, contains: q, ...(Number.isFinite(before) ? { beforeId: before } : {}) });
    json(200, { items: items.map(changeView) });
    return true;
  }

  const undo = url.pathname.match(/^\/api\/memory\/changes\/(\d+)\/undo$/);
  if (!undo) return false;
  if (method !== "POST") { json(405, { error: "POST only" }); return true; }
  if (requestRole !== "operator") { json(403, { error: "Operator role required" }); return true; }
  const result = ctx.memoryIndex.undoMemoryChange(Number(undo[1]), "user:undo");
  if (!result.ok) { json(409, { error: result.message }); return true; }
  ctx.broadcastAll({ type: "settings_changed", settings: { memoryChanges: true } });
  json(200, { ok: true, message: result.message, factId: result.factId });
  return true;
};
