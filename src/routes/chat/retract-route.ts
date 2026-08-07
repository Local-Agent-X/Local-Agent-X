import type { IncomingMessage, ServerResponse } from "node:http";

import { z } from "zod";

import { broadcastToSession } from "../../chat-ws/state.js";
import { retractLastTurn } from "../../memory/retract-last-turn.js";
import { validateBody } from "../../route-schemas.js";
import type { ServerContext } from "../../server-context.js";
import { jsonResponse, safeParseBody } from "../../server-utils.js";
import { hasActiveTurn } from "../../session/turn-lock.js";

// "turn"     → drop the whole last user+assistant/tool turn (drop-last / edit-resend)
// "response" → keep the last user row, drop only its trailing answer (regenerate)
const RetractSchema = z.object({
	sessionId: z.string().regex(/^[a-zA-Z0-9_-]{1,64}$/).optional().default("default"),
	mode: z.enum(["turn", "response"]).optional().default("turn"),
});

/**
 * Handle POST /api/retract. Hard-truncates the tail of `session.messages` —
 * the sessionId-keyed conversation history that seeds every new turn's model
 * context — so the last committed turn stops polluting context. Mirrors
 * POST /api/compact's read-modify-write skeleton.
 *
 * mode:"turn" removes the whole last turn INCLUSIVE of its user row (for
 * drop-last / edit-and-resend); mode:"response" keeps the user row and drops
 * only the trailing assistant/tool rows (for regenerate). The leading
 * compaction-summary row is the floor and is never removed.
 *
 * Returns `true` if the request was handled.
 */
export async function handleRetractRoute(
	method: string,
	url: URL,
	req: IncomingMessage,
	res: ServerResponse,
	ctx: ServerContext,
): Promise<boolean> {
	if (!(method === "POST" && url.pathname === "/api/retract")) return false;

	const json = (status: number, data: unknown) => jsonResponse(res, status, data, req);
	const raw = await safeParseBody(req);
	const parsed = validateBody(raw, RetractSchema);
	if (!parsed.success) { json(400, { error: parsed.error }); return true; }

	const sessionId = parsed.data.sessionId!;
	// Read-modify-write of the transcript: flush any in-flight bridge write
	// first, or we'd truncate a transcript missing the very turn being retracted.
	await ctx.flushSession(sessionId);

	// A live turn is still writing this transcript; retracting under it would
	// race the writer (last-writer-wins) and drop rows out from under it. The
	// caller must cancel the turn first, then retract.
	if (hasActiveTurn(sessionId)) {
		json(409, { ok: false, reason: "A turn is active for this session; cancel it before retracting." });
		return true;
	}

	const session = ctx.getOrCreateSession(sessionId);
	const includeUser = parsed.data.mode === "turn";
	const { messages, removed } = retractLastTurn(session.messages, { includeUser });

	if (removed === 0) {
		json(200, { ok: false, reason: "Nothing to retract (no committed user turn above the compaction floor).", removed: 0 });
		return true;
	}

	session.messages = messages;
	session.updatedAt = Date.now();
	ctx.sessionStore.save(session);

	// The compact route does NOT broadcast; retract SHOULD, so OTHER sockets
	// on this session re-render from the server's now-authoritative history
	// instead of showing the turn we just dropped.
	broadcastToSession(sessionId, { type: "history_changed", sessionId });

	json(200, { ok: true, mode: parsed.data.mode, removed, messageCount: session.messages.length });
	return true;
}
