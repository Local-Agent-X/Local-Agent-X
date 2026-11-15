import type { RouteHandler } from "../../server-context.js";
import { jsonResponse, safeErrorMessage } from "../../server-utils.js";

/** In-app updates: check, progress, apply (src/update-service.ts, update-progress.ts). */
export const handleUpdateRoutes: RouteHandler = async (method, url, req, res) => {
  if (!url.pathname.startsWith("/api/updates/")) return false;
  const json = (status: number, data: unknown) => jsonResponse(res, status, data, req);

  // Update check + apply — the implementation lives in update-service.ts so the
  // agent tools (check_for_updates / apply_update) share it. Apply routes
  // through update-pipeline's validated swap (deps/build/bind/smoke gates);
  // nothing overwrites the live install until the candidate passes. The caller
  // restarts to finish (desktop has IPC for that; browser users restart manually).
  if (method === "GET" && url.pathname === "/api/updates/check") {
    const { checkForUpdate } = await import("../../update-service.js");
    json(200, await checkForUpdate());
    return true;
  }

  // How far an update has got, for the progress bar; also says when a
  // background-prepared update is ready to install (update-progress.ts).
  if (method === "GET" && url.pathname === "/api/updates/progress") {
    const { updateProgress } = await import("../../update-progress.js");
    const { readyUpdate } = await import("../../update-staging.js");
    json(200, updateProgress(readyUpdate() !== null));
    return true;
  }

  if (method === "POST" && url.pathname === "/api/updates/apply") {
    try {
      const { applyUpdateNow } = await import("../../update-service.js");
      const result = await applyUpdateNow();
      if (result.ok) {
        json(200, { ok: true, fromCommit: result.fromCommit, toCommit: result.toCommit, output: result.detail, ...(result.rolling ? { rolling: true } : {}) });
      } else {
        json(result.held ? 409 : 500, { ok: false, held: !!result.held, fromCommit: result.fromCommit, toCommit: result.toCommit, error: result.detail, ...(result.rolling ? { rolling: true } : {}) });
      }
    } catch (e) { json(500, { ok: false, error: safeErrorMessage(e) }); }
    return true;
  }

  return false;
};
