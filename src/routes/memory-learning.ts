import type { RouteHandler } from "../server-context.js";
import { getRuntimeConfig } from "../config.js";
import { jsonResponse, safeParseBody } from "../server-utils.js";
import learningService, {
  type LearningAction,
  type LearningDetail,
} from "../cognition/cross-session-learning/service.js";

const ID_PATTERN = /^learned-[a-f0-9]{20}$/;
const VERSION_PATTERN = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const ACTIONS = new Set(["activate", "reject", "archive", "restore", "rollback"]);

function parseAction(body: Record<string, unknown>): LearningAction | null {
  if (!body || Array.isArray(body) || typeof body.action !== "string" || !ACTIONS.has(body.action)) return null;
  const action = body.action as LearningAction["action"];
  const keys = Object.keys(body);
  if (action === "reject") {
    const hasUiNullCas = keys.length === 2
      && keys.includes("expectedActiveVersionId")
      && body.expectedActiveVersionId === null;
    return keys.length === 1 || hasUiNullCas ? { action } : null;
  }

  if (!("expectedActiveVersionId" in body)) return null;
  const expected = body.expectedActiveVersionId;
  if (expected !== null && (typeof expected !== "string" || !VERSION_PATTERN.test(expected))) return null;

  if (action === "activate") {
    if (keys.some((key) => !["action", "versionId", "expectedActiveVersionId"].includes(key))) return null;
    if (body.versionId !== undefined && (typeof body.versionId !== "string" || !VERSION_PATTERN.test(body.versionId))) return null;
    return {
      action,
      ...(typeof body.versionId === "string" ? { versionId: body.versionId } : {}),
      expectedActiveVersionId: expected,
    };
  }
  if (action === "rollback") {
    if (keys.length !== 3 || typeof body.versionId !== "string" || !VERSION_PATTERN.test(body.versionId)) return null;
    return { action, versionId: body.versionId, expectedActiveVersionId: expected };
  }
  if (keys.length !== 2 || "versionId" in body) return null;
  return { action, expectedActiveVersionId: expected };
}

function isStaleVersionError(error: unknown): boolean {
  return error instanceof Error && /active learned protocol version changed/i.test(error.message);
}

function sameDetail(before: LearningDetail, after: LearningDetail): boolean {
  return JSON.stringify(before) === JSON.stringify(after);
}

export const handleMemoryLearningRoutes: RouteHandler = async (method, url, req, res, ctx, requestRole) => {
  const json = (status: number, data: unknown) => jsonResponse(res, status, data, req);
  if (method === "GET" && url.pathname === "/api/memory/learning") {
    try {
      const mode = getRuntimeConfig().learningMode;
      json(200, { mode, items: learningService.list() });
    } catch {
      json(500, { error: "Learning request failed" });
    }
    return true;
  }

  const actionMatch = url.pathname.match(/^\/api\/memory\/learning\/([^/]+)\/action$/);
  const detailMatch = url.pathname.match(/^\/api\/memory\/learning\/([^/]+)$/);
  const match = actionMatch ?? detailMatch;
  if (!match || (actionMatch && method !== "POST") || (detailMatch && method !== "GET")) return false;
  const id = match[1];
  if (!ID_PATTERN.test(id)) { json(400, { error: "Invalid learning item id" }); return true; }

  let before: LearningDetail | null;
  try { before = learningService.detail(id); }
  catch { json(500, { error: "Learning request failed" }); return true; }
  if (!before) { json(404, { error: "Learning item not found" }); return true; }
  if (detailMatch) { json(200, { item: before }); return true; }

  if (requestRole !== "operator") { json(403, { error: "Operator role required" }); return true; }
  let body: Record<string, unknown> | null;
  try { body = await safeParseBody(req); }
  catch { body = null; }
  const action = body ? parseAction(body) : null;
  if (!action) { json(400, { error: "Invalid learning action body" }); return true; }

  try {
    const item = learningService.action(id, action);
    if (!sameDetail(before, item)) ctx.broadcastAll({ type: "learning_changed", id, action: action.action });
    json(200, { item });
  } catch (error) {
    if (isStaleVersionError(error)) json(409, { error: "Active learning version changed" });
    else json(500, { error: "Learning request failed" });
  }
  return true;
};
