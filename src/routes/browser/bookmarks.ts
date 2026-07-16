import type { RouteHandler } from "../../server-context.js";
import { jsonResponse, safeParseBody } from "../../server-utils.js";
import { BrowserBookmarkStore } from "../../browser/bookmark-store.js";

/**
 * Shared bookmarks — thin wrappers over the BrowserBookmarkStore singleton
 * (same access pattern as the profile routes). Bookmarks created here are
 * stamped addedBy:"user"; agents add theirs through the browser tool's
 * bookmark_add action (addedBy:"agent") against the SAME store.
 *
 *   GET    /api/browser/bookmarks          — ?q=&profile= (newest first)
 *   POST   /api/browser/bookmarks          — { url, title?, tags?, profileId? }
 *   DELETE /api/browser/bookmarks/:id      — remove one bookmark
 */
export const handleBrowserBookmarkRoutes: RouteHandler = async (method, url, req, res, _ctx, _role) => {
  const json = (status: number, data: unknown) => jsonResponse(res, status, data, req);
  const store = BrowserBookmarkStore.getInstance();

  if (method === "GET" && url.pathname === "/api/browser/bookmarks") {
    const q = url.searchParams.get("q") ?? undefined;
    const profileId = url.searchParams.get("profile") ?? undefined;
    json(200, store.list({ q, profileId }));
    return true;
  }

  if (method === "POST" && url.pathname === "/api/browser/bookmarks") {
    const raw = await safeParseBody(req) as Record<string, unknown> | null;
    const bookmarkUrl = typeof raw?.url === "string" ? raw.url.trim() : "";
    if (!bookmarkUrl) { json(400, { error: "'url' is required" }); return true; }
    if (raw?.tags !== undefined && !Array.isArray(raw.tags)) {
      json(400, { error: "'tags' must be an array of strings" }); return true;
    }
    try {
      json(200, store.add({
        url: bookmarkUrl,
        title: typeof raw?.title === "string" ? raw.title : undefined,
        tags: raw?.tags as string[] | undefined,
        profileId: typeof raw?.profileId === "string" && raw.profileId.trim() !== "" ? raw.profileId : undefined,
        addedBy: "user",
      }));
    } catch (e) {
      json(400, { error: (e as Error).message });
    }
    return true;
  }

  if (method === "DELETE" && url.pathname.match(/^\/api\/browser\/bookmarks\/[^/]+$/)) {
    const id = decodeURIComponent(url.pathname.split("/").pop()!);
    const ok = store.remove(id);
    json(ok ? 200 : 404, { ok });
    return true;
  }

  return false;
};
