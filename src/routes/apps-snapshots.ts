/**
 * Snapshot routes split out of routes/apps.ts so the parent file stays
 * under the 400-LOC cap. Two endpoints:
 *   GET  /api/apps/<id>/snapshots → newest-first list (capped at 5)
 *   POST /api/apps/<id>/revert    → restore files from {turnIdx, ts}
 *
 * Storage model lives in src/app-tools/snapshots.ts.
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import { safeParseBody } from "../server-utils.js";
import { listAppSnapshots, revertAppToSnapshot } from "../tools/app-tools/snapshots.js";

type Json = (status: number, data: unknown) => void;

export async function handleAppSnapshotsRoutes(
  method: string,
  appPath: string,
  req: IncomingMessage,
  _res: ServerResponse,
  json: Json,
  workspaceDir: string,
): Promise<boolean> {
  const listMatch = appPath.match(/^\/api\/apps\/([a-zA-Z0-9_-]+)\/snapshots$/);
  if (method === "GET" && listMatch) {
    const id = listMatch[1];
    try { json(200, listAppSnapshots(id)); }
    catch (e) { json(500, { error: (e as Error).message }); }
    return true;
  }

  const revertMatch = appPath.match(/^\/api\/apps\/([a-zA-Z0-9_-]+)\/revert$/);
  if (method === "POST" && revertMatch) {
    const id = revertMatch[1];
    const body = await safeParseBody(req);
    if (!body || typeof body.turnIdx !== "number" || typeof body.ts !== "number") {
      json(400, { error: "turnIdx and ts (numbers) required" });
      return true;
    }
    try {
      const result = revertAppToSnapshot(id, workspaceDir, body.turnIdx, body.ts);
      if (result.restored.length === 0 && result.errors.length > 0) {
        json(404, { ok: false, ...result });
        return true;
      }
      json(200, { ok: true, ...result });
    } catch (e) { json(500, { error: (e as Error).message }); }
    return true;
  }

  return false;
}
