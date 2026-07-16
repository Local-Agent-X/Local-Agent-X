import type { RouteHandler } from "../../server-context.js";
import { jsonResponse } from "../../server-utils.js";
import { BrowserHistoryStore } from "../../browser/history-store.js";

/** Hard ceiling on a single history query — the store caps at 500/profile. */
const MAX_HISTORY_LIMIT = 500;

/**
 * Shared browser history — thin wrappers over the BrowserHistoryStore
 * singleton (same access pattern as the profile routes). Entries are already
 * redacted at write time (store privacy law), so reads serve them as-is.
 *
 *   GET    /api/browser/history            — ?q=&profile=&limit= (newest first)
 *   DELETE /api/browser/history/:id        — delete one entry
 *   DELETE /api/browser/history            — clear all history
 */
export const handleBrowserHistoryRoutes: RouteHandler = async (method, url, req, res, _ctx, _role) => {
  const json = (status: number, data: unknown) => jsonResponse(res, status, data, req);
  const store = BrowserHistoryStore.getInstance();

  if (method === "GET" && url.pathname === "/api/browser/history") {
    const q = url.searchParams.get("q") ?? undefined;
    const profileId = url.searchParams.get("profile") ?? undefined;
    const rawLimit = Number(url.searchParams.get("limit"));
    const limit = Number.isFinite(rawLimit) && rawLimit > 0 ? Math.min(rawLimit, MAX_HISTORY_LIMIT) : 50;
    json(200, store.query({ q, profileId, limit }));
    return true;
  }

  if (method === "DELETE" && url.pathname === "/api/browser/history") {
    json(200, { ok: true, cleared: store.clear() });
    return true;
  }

  if (method === "DELETE" && url.pathname.match(/^\/api\/browser\/history\/[^/]+$/)) {
    const id = decodeURIComponent(url.pathname.split("/").pop()!);
    const ok = store.remove(id);
    json(ok ? 200 : 404, { ok });
    return true;
  }

  return false;
};
