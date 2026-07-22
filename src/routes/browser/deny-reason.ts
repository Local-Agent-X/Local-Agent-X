import type { RouteHandler } from "../../server-context.js";
import { jsonResponse } from "../../server-utils.js";
import { peekEgressDeny } from "../../browser/bridge-egress.js";

/**
 * Deny-reason lookup for the in-app browser's error card. A policy-denied
 * request renders in the view as bare ERR_BLOCKED_BY_CLIENT; the real reason
 * sits in the recent-deny cache (bridge-egress.ts). This route PEEKS that
 * cache — non-consuming, so the agent-side navigate error path still gets its
 * one recentEgressDeny consume.
 *
 *   GET /api/browser/deny-reason?url=<encoded>&viewId=<optional>
 *     → { reason, recovery? } when a recent deny is recorded, {} otherwise
 */
export const handleBrowserDenyReasonRoutes: RouteHandler = async (method, url, req, res, _ctx, _role) => {
  if (method !== "GET" || url.pathname !== "/api/browser/deny-reason") return false;
  const target = url.searchParams.get("url") ?? "";
  if (!target) { jsonResponse(res, 400, { error: "'url' is required" }, req); return true; }
  const viewId = url.searchParams.get("viewId") ?? undefined;
  jsonResponse(res, 200, peekEgressDeny(target, viewId) ?? {}, req);
  return true;
};
