import type { IncomingMessage, ServerResponse } from "node:http";

import { listActiveCanonicalOps } from "../../canonical-loop/index.js";
import { prewarmNewChat } from "../../local-runtimes/prompt-prewarm.js";
import { jsonResponse } from "../../server-utils.js";
import { loadSettings } from "../../settings.js";

/**
 * Handle POST /api/chat/prewarm — the UI opened a new chat. Replays the last
 * fresh local chat's head so the first message reuses the runtime's cache
 * (local-runtimes/prompt-prewarm.ts). Answers at once; the prefill runs in the
 * background. A no-op unless the chat is on the local model that head was
 * recorded for, and never while a foreground turn is running.
 */
export async function handlePrewarmRoute(
	method: string,
	url: URL,
	req: IncomingMessage,
	res: ServerResponse,
): Promise<boolean> {
	if (!(method === "POST" && url.pathname === "/api/chat/prewarm")) return false;
	const settings = loadSettings();
	const outcome = prewarmNewChat({
		current: { provider: String(settings.provider ?? ""), model: String(settings.model ?? "") },
		foregroundBusy: listActiveCanonicalOps().some(op => op.lane !== "background" && (op.state === "queued" || op.state === "running")),
	});
	jsonResponse(res, 202, { outcome }, req);
	return true;
}
