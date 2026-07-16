import { rmSync } from "node:fs";
import type { RouteHandler } from "../../server-context.js";
import { jsonResponse, safeParseBody } from "../../server-utils.js";
import { BrowserProfileStore, profileUserDataDir, type BrowserProfile } from "../../browser/profile-store.js";
import { browserClearPartition } from "../../browser/bridge-client.js";
import { BrowserProfileSchema, BrowserProfileUpdateSchema, validateBody } from "../../route-schemas.js";
import { createLogger } from "../../logger.js";

const logger = createLogger("browser-profile-routes");

/**
 * Clear a profile's saved logins WITHOUT deleting the profile record. A profile
 * resolves to two physical stores keyed by the same id, so both must be wiped:
 *   - the Electron partition (in-app backend) — cleared over the bridge, which
 *     enforces the navigate-to-blank-then-clear ordering desktop-side so a live
 *     view can't re-persist cookies past the wipe;
 *   - the CDP userDataDir twin (external-Chrome backend) — removed from disk
 *     here, server-side.
 * The bridge leg is best-effort: off-desktop there is no Electron partition to
 * clear, so BridgeUnavailableError (and any bridge failure) is logged and the
 * disk wipe still runs. Clearing an id with no live view is a valid no-op wipe.
 */
async function clearProfileData(profile: BrowserProfile): Promise<void> {
  try {
    await browserClearPartition(profile.partition);
  } catch (e) {
    // Unavailable bridge (not under the desktop app) or a wipe failure — neither
    // should block clearing the on-disk CDP twin. Fail-safe: log and continue.
    logger.info(`[browser-profiles] partition clear skipped/failed for ${profile.id}: ${(e as Error).message}`);
  }
  // Remove the CDP userDataDir twin entirely; it is recreated empty on the next
  // external-Chrome launch, which is exactly a fresh (logged-out) profile.
  // Guard the recursive delete: only ever wipe the store's own canonical dir for
  // this id, never a path carried in from elsewhere — a corrupted/empty
  // userDataDir must not turn this into an over-broad rm.
  const canonicalDir = profileUserDataDir(profile.id);
  if (profile.userDataDir !== canonicalDir) {
    logger.info(`[browser-profiles] refusing to clear non-canonical userDataDir for ${profile.id}`);
    return;
  }
  rmSync(canonicalDir, { recursive: true, force: true });
}

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

  // Clear a profile's saved logins (cookies/storage) but keep the profile. The
  // /data suffix keeps this disjoint from the plain-delete route below — even
  // the protected default profile is clearable (you can log it out), only
  // deletion is refused. Destructive: the UI double-confirms.
  if (method === "DELETE" && url.pathname.match(/^\/api\/browser\/profiles\/[^/]+\/data$/)) {
    const id = url.pathname.split("/")[4];
    const profile = store.get(id);
    if (!profile) { json(404, { error: "Profile not found" }); return true; }
    await clearProfileData(profile);
    json(200, { ok: true }); return true;
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
