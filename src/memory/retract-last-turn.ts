import type { ChatCompletionMessageParam } from "openai/resources/chat/completions.js";

import { COMPACTION_PREFIX } from "../types.js";

export interface RetractOptions {
	/**
	 * true  → drop the whole last turn INCLUSIVE of its trailing `user` row
	 *         (drop-last / edit-and-resend): remove from the tail back through
	 *         and including that user message.
	 * false → keep the last `user` row, drop only the trailing
	 *         assistant/tool rows that answered it (regenerate).
	 */
	includeUser: boolean;
}

export interface RetractResult {
	messages: ChatCompletionMessageParam[];
	/** Count of rows removed from the tail. 0 means nothing changed. */
	removed: number;
}

/**
 * Pure, I/O-free truncation of `session.messages`. Finds the last `user` row
 * and removes the tail from there (the last committed turn) so it stops
 * seeding new-turn model context.
 *
 * COMPACTION FLOOR: a leading `{role:"system", content:"[COMPACTED CONTEXT — …]"}`
 * row (COMPACTION_PREFIX) is the immovable floor — it is never a `user` row so
 * the search never selects it, and the search range excludes index 0 when the
 * floor is present, so it can never be truncated away.
 *
 * VOICE-SAFE: operates purely on message ROLES, never on op type, so it treats
 * a voice_turn's committed rows exactly like a chat turn's.
 *
 * Returns the input unchanged (removed:0) when there is no `user` row to cut
 * back to (empty array, compaction-only, or a transcript with no user turn).
 */
export function retractLastTurn(
	messages: ChatCompletionMessageParam[],
	opts: RetractOptions,
): RetractResult {
	const first = messages[0];
	const hasCompactionFloor =
		first !== undefined &&
		first.role === "system" &&
		typeof first.content === "string" &&
		first.content.startsWith(COMPACTION_PREFIX);
	// Rows at indices below `floor` are protected and never scanned/removed.
	const floor = hasCompactionFloor ? 1 : 0;

	let userIdx = -1;
	for (let i = messages.length - 1; i >= floor; i--) {
		if (messages[i].role === "user") { userIdx = i; break; }
	}
	if (userIdx === -1) return { messages, removed: 0 };

	// turn mode: cut the user row too; response mode: keep it, drop what follows.
	const cut = opts.includeUser ? userIdx : userIdx + 1;
	const removed = messages.length - cut;
	if (removed <= 0) return { messages, removed: 0 };

	return { messages: messages.slice(0, cut), removed };
}
