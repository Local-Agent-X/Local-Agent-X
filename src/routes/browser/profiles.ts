import type { RouteHandler } from "../../server-context.js";
import { jsonResponse, safeParseBody } from "../../server-utils.js";
import { BrowserProfileStore } from "../../browser/profile-store.js";
import { BrowserProfileSchema, BrowserProfileUpdateSchema, validateBody } from "../../route-schemas.js";

/**
 * Browser profiles CRUD — thin wrappers over the BrowserProfileStore singleton
 * (same access pattern the hire routes use for ProjectRosterStore). The store is
 * the source of truth; these routes exist so the profile-manager UI can reach it
 * over HTTP.
 */
export const handleBrowserProfileRoutes: RouteHandler = async (method, url, req, res, _ctx, _role) => {
  const json = (status: number, data: unknown) => jsonResponse(res, status, data, req);
  const store = BrowserProfileStore.getInstance();

  if (method === "GET" && url.pathname === "/api/browser/profiles") {
    json(200, store.list()); return true;
  }

  if (method === "POST" && url.pathname === "/api/browser/profiles") {
    const raw = await safeParseBody(req);
    const parsed = validateBody(raw, BrowserProfileSchema);
    if (!parsed.success) { json(400, { error: parsed.error }); return true; }
    try {
      json(200, store.create(parsed.data));
    } catch (e) {
      const err = e as Error & { code?: string; existingId?: string };
      json(err.code === "PROFILE_NAME_EXISTS" ? 409 : 400, { error: err.message, code: err.code, existingId: err.existingId });
    }
    return true;
  }

  if (method === "PUT" && url.pathname.match(/^\/api\/browser\/profiles\/[^/]+$/)) {
    const id = url.pathname.split("/").pop()!;
    const raw = await safeParseBody(req);
    const parsed = validateBody(raw, BrowserProfileUpdateSchema);
    if (!parsed.success) { json(400, { error: parsed.error }); return true; }
    try {
      const updated = store.update(id, parsed.data);
      if (!updated) { json(404, { error: "Profile not found" }); return true; }
      json(200, updated);
    } catch (e) {
      const err = e as Error & { code?: string };
      json(err.code === "PROFILE_NAME_EXISTS" ? 409 : 400, { error: err.message, code: err.code });
    }
    return true;
  }

  if (method === "DELETE" && url.pathname.match(/^\/api\/browser\/profiles\/[^/]+$/)) {
    const id = url.pathname.split("/").pop()!;
    const ok = store.delete(id);
    // The default profile is protected — 409 distinguishes "can't delete" from
    // "not found" so the UI can message it correctly.
    if (!ok && id === "default") { json(409, { error: "The default profile can't be deleted" }); return true; }
    json(ok ? 200 : 404, { ok }); return true;
  }

  return false;
};
