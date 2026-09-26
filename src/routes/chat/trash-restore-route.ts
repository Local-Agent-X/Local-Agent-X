import type { IncomingMessage, ServerResponse } from "node:http";

import { restoreDeleted } from "../../trash-restore.js";
import { jsonResponse, safeParseBody } from "../../server-utils.js";

const MAX_PATHS = 50;

/**
 * Handle POST /api/trash/restore — the Undo on a delete notice (a file this
 * request created, deleted to the trash without a card; see
 * tool-execution/unnamed-delete-gate.ts). Body: { paths: string[], sessionId? }.
 * Each path goes through restoreDeleted, the same restore restore_file runs,
 * which only moves back what the trash journal recorded, to where it was.
 * Answers one result per path.
 */
export async function handleTrashRestoreRoute(
	method: string,
	url: URL,
	req: IncomingMessage,
	res: ServerResponse,
): Promise<boolean> {
	if (!(method === "POST" && url.pathname === "/api/trash/restore")) return false;
	const body = await safeParseBody(req);
	const paths = body?.paths;
	if (!Array.isArray(paths) || paths.length === 0 || paths.length > MAX_PATHS || !paths.every((p) => typeof p === "string" && p.length > 0)) {
		jsonResponse(res, 400, { error: `paths must be 1–${MAX_PATHS} non-empty strings` }, req);
		return true;
	}
	const sessionId = typeof body?.sessionId === "string" ? body.sessionId : undefined;
	const results = (paths as string[]).map((path) => ({ path, ...restoreDeleted(path, { sessionId }) }));
	jsonResponse(res, 200, { results }, req);
	return true;
}
