// Read-only tool: pages RAW conversation history out of the canonical op
// store. Complements the summarizing surfaces (compaction digests,
// search_past_sessions): when earlier conversation was compacted into a
// summary, the summary cites a message range — recall reads the original
// messages back verbatim.
//
// Sealed read path (store.ts SEAL): rows come from readOpMessages() and are
// projected through opMessageRowToChatParam() — the only sanctioned shape
// adapter. This module never parses op_messages JSONL itself.

import type { ChatCompletionMessageParam } from "openai/resources/chat/completions.js";
import type { ToolDefinition, ToolResult } from "../types.js";
import type { OpMessageRow } from "../canonical-loop/types.js";

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 50;
const SNIPPET_CHARS = 200;
const PART_MAX_CHARS = 5000;
const MAX_OUTPUT_CHARS = 6000;

export interface RecallDeps {
	readOpMessages: (opId: string) => OpMessageRow[];
	toChatParam: (row: OpMessageRow) => ChatCompletionMessageParam | null;
	listOps: () => Array<{ id: string; canonical?: { sessionId?: string | null } | undefined }>;
}

async function defaultDeps(): Promise<RecallDeps> {
	const [store, convert, ops] = await Promise.all([
		import("../canonical-loop/store.js"),
		import("../canonical-loop/chat-runner/message-convert.js"),
		import("../ops/op-store.js"),
	]);
	return {
		readOpMessages: store.readOpMessages,
		toChatParam: convert.opMessageRowToChatParam,
		listOps: ops.listOps,
	};
}

interface RecallMsg {
	row: OpMessageRow;
	param: ChatCompletionMessageParam;
}

function ok(content: string): ToolResult { return { content }; }
function err(content: string): ToolResult { return { content, isError: true }; }

/** Cursor may be a bare messageId or a "startId:endId" range (the format
 * compaction summaries cite). */
export function parseCursor(cursor: string): { startId: string; endId?: string } {
	const i = cursor.indexOf(":");
	if (i === -1) return { startId: cursor };
	return { startId: cursor.slice(0, i), endId: cursor.slice(i + 1) || undefined };
}

function paramText(param: ChatCompletionMessageParam): string {
	const c = (param as { content?: unknown }).content;
	return typeof c === "string" ? c : "";
}

function toolCallsOf(param: ChatCompletionMessageParam): Array<{ name: string; arguments: string }> {
	const tcs = (param as { tool_calls?: Array<{ function?: { name?: string; arguments?: string } }> }).tool_calls;
	if (!Array.isArray(tcs)) return [];
	return tcs.map(tc => ({ name: tc.function?.name ?? "?", arguments: tc.function?.arguments ?? "" }));
}

/** Split a message into displayable parts: text (chunked when oversized),
 * one part per tool call, one per image attachment. */
export function messageParts(param: ChatCompletionMessageParam): string[] {
	const parts: string[] = [];
	const text = paramText(param);
	if (text) {
		for (let i = 0; i < text.length; i += PART_MAX_CHARS) {
			parts.push(text.slice(i, i + PART_MAX_CHARS));
		}
	}
	for (const tc of toolCallsOf(param)) {
		parts.push(`[tool_call] ${tc.name}(${tc.arguments})`);
	}
	const images = (param as { images?: Array<{ name?: string }> }).images;
	if (Array.isArray(images)) {
		for (const im of images) parts.push(`[image] ${im?.name ?? "(unnamed)"}`);
	}
	if (parts.length === 0) parts.push("");
	return parts;
}

function roleOf(param: ChatCompletionMessageParam): string { return param.role; }

function when(row: OpMessageRow): string {
	return String(row.createdAt ?? "").replace("T", " ").slice(0, 16);
}

function truncHint(messageId: string): string {
	return `  [truncated — call recall with cursor="${messageId}" detail="high" for full content]`;
}

/** One low-detail entry (1 line, or 2 when a truncation hint is appended). */
export function renderLow(msg: RecallMsg): string {
	const parts = messageParts(msg.param);
	const names = toolCallsOf(msg.param).map(tc => tc.name);
	const prefix = names.length > 0 ? `calls: ${names.join(", ")} — ` : "";
	let body: string;
	let truncated = false;
	if (parts.length === 1) {
		const t = parts[0].replace(/\s+/g, " ").trim();
		truncated = t.length > SNIPPET_CHARS;
		body = truncated ? `${t.slice(0, SNIPPET_CHARS)}…` : t;
	} else {
		const t = parts.map((p, i) => `[p${i}] ${p.replace(/\s+/g, " ").trim()}`).join(" ");
		truncated = true; // multi-part is by definition not fully shown
		body = t.length > SNIPPET_CHARS ? `${t.slice(0, SNIPPET_CHARS)}…` : t;
	}
	const line = `[${msg.row.messageId}] ${roleOf(msg.param)} ${when(msg.row)} | ${prefix}${body}`;
	return truncated ? `${line}\n${truncHint(msg.row.messageId)}` : line;
}

export interface PageResult {
	slice: RecallMsg[];
	startIdx: number;
	total: number;
	scopeNote: string;
	error?: string;
}

/** Compute the page window over the chronological message list.
 *  - no cursor: page 1 = newest `limit`, page 2 = the `limit` before, …
 *  - bare cursor: page 1 = the `limit` messages strictly BEFORE the cursor
 *    (back in time); negative pages go forward from just after it.
 *  - range cursor: scope narrows to [startId..endId]; page 1 = the FIRST
 *    `limit` messages of the range (read a summarized region in order). */
export function pageMessages(msgs: RecallMsg[], opts: { cursor?: string; page: number; limit: number }): PageResult {
	const { cursor, limit } = opts;
	const page = opts.page === 0 ? 1 : Math.trunc(opts.page);
	let list = msgs;
	let scopeNote = "";
	let start: number;
	if (cursor) {
		const { startId, endId } = parseCursor(cursor);
		const sIdx = msgs.findIndex(m => m.row.messageId === startId);
		if (sIdx === -1) {
			return { slice: [], startIdx: 0, total: msgs.length, scopeNote: "", error: `cursor messageId "${startId}" not found in this op's history` };
		}
		if (endId !== undefined) {
			const eIdxRaw = msgs.findIndex(m => m.row.messageId === endId);
			const eIdx = eIdxRaw === -1 ? msgs.length - 1 : eIdxRaw;
			list = msgs.slice(sIdx, eIdx + 1);
			scopeNote = ` within range ${startId}:${endId}`;
			start = page >= 1
				? (page - 1) * limit
				: list.length - (-page) * limit;
		} else {
			// bare cursor: pages count back in time from (exclusive of) the cursor
			start = page >= 1
				? sIdx - page * limit
				: sIdx + 1 + (-page - 1) * limit;
			scopeNote = ` from cursor ${startId}`;
		}
	} else {
		start = list.length - page * limit; // page>=1 back from the end
		if (page < 0) start = (-page - 1) * limit; // forward from the start
	}
	const clampedStart = Math.max(0, start);
	const end = Math.min(list.length, Math.max(0, start + limit));
	return { slice: list.slice(clampedStart, end), startIdx: clampedStart, total: list.length, scopeNote };
}

function renderLowPage(res: PageResult, opId: string, page: number): string {
	if (res.slice.length === 0) {
		return `No messages in that page (op ${opId}${res.scopeNote}; ${res.total} message(s) total). Adjust page/cursor.`;
	}
	const header = `recall op ${opId}${res.scopeNote} — messages ${res.startIdx + 1}–${res.startIdx + res.slice.length} of ${res.total}, oldest→newest (page ${page}; older: page=${page + 1}, newer: page=${page - 1}):`;
	const entries = res.slice.map(renderLow);
	// Cap total output: drop OLDEST entries first, keep the cap note explicit.
	let kept = entries.slice();
	let dropped = 0;
	while (kept.length > 1 && `${header}\n${kept.join("\n")}`.length > MAX_OUTPUT_CHARS) {
		kept = kept.slice(1);
		dropped++;
	}
	const capNote = dropped > 0
		? `\n[output capped — ${dropped} older message(s) omitted from this page; call recall with cursor="${res.slice[dropped].row.messageId}" to page back from there]`
		: "";
	return `${header}${capNote}\n${kept.join("\n")}`;
}

function renderHigh(msgs: RecallMsg[], target: RecallMsg, partIndex: number | undefined): string {
	const idx = msgs.indexOf(target);
	const parts = messageParts(target.param);
	const hints: string[] = [];
	const prev = idx > 0 ? msgs[idx - 1] : null;
	const next = idx >= 0 && idx < msgs.length - 1 ? msgs[idx + 1] : null;
	if (prev) hints.push(`[previous message: call recall with cursor="${prev.row.messageId}" detail="high"]`);
	if (next) hints.push(`[next message: call recall with cursor="${next.row.messageId}" detail="high"]`);
	const head = `[${target.row.messageId}] ${roleOf(target.param)} ${when(target.row)} (${parts.length} part(s))`;
	const full = parts.map((p, i) => (parts.length > 1 ? `[p${i}] ${p}` : p)).join("\n");
	let body: string;
	if (partIndex !== undefined) {
		if (partIndex < 0 || partIndex >= parts.length) {
			body = `partIndex ${partIndex} out of range — this message has ${parts.length} part(s) (p0–p${parts.length - 1}).`;
		} else {
			body = `[p${partIndex}] ${parts[partIndex]}`;
			if (partIndex > 0) hints.unshift(`[previous part: partIndex=${partIndex - 1}]`);
			if (partIndex < parts.length - 1) hints.unshift(`[next part: call recall with cursor="${target.row.messageId}" detail="high" partIndex=${partIndex + 1}]`);
		}
	} else if (full.length > MAX_OUTPUT_CHARS) {
		body = `[p0] ${parts[0]}`;
		hints.unshift(`[message oversized (${parts.length} part(s)) — call recall with cursor="${target.row.messageId}" detail="high" partIndex=1 for the next part]`);
	} else {
		body = full;
	}
	return `${head}\n${body}${hints.length > 0 ? `\n${hints.join("\n")}` : ""}`;
}

export function createRecallTool(deps?: RecallDeps): ToolDefinition {
	return {
		name: "recall",
		description:
			"Page through the RAW messages of this conversation (or another op's) from the canonical store — exact user/assistant/tool messages, not summaries. " +
			"Use it to re-read what was actually said earlier. When earlier conversation was summarized (compacted), the summary cites a message range like \"startId:endId\" — pass that range as `cursor` to read the original messages it replaced. " +
			"detail=\"low\" (default) lists one line per message with messageIds; detail=\"high\" with cursor=<messageId> returns that one message in full (use partIndex for oversized messages). " +
			"page=1 is the most recent page, higher pages go further back in time. " +
			"This is the verbatim transcript — for stored facts use memory_search, for other conversations use search_past_sessions, for your own tool actions use read_my_logs.",
		readOnly: true,
		parameters: {
			type: "object",
			properties: {
				cursor: { type: "string", description: "A messageId to page from, or a \"startId:endId\" range cited by a compaction summary (pages within the range). With detail=\"high\", the message to read in full." },
				page: { type: "number", description: "Signed page number, default 1 = next page back in time (or first page of a range cursor). Negative pages go the other direction." },
				limit: { type: "number", description: "Messages per page (default 20, max 50)." },
				detail: { type: "string", enum: ["low", "high"], description: "\"low\" (default): one line per message. \"high\": ONE message's full content." },
				partIndex: { type: "number", description: "With detail=\"high\": return just this part of an oversized/multi-part message (0-based)." },
				opId: { type: "string", description: "Explicit op to read. Default: the current session's most recent op." },
			},
			required: [],
		},
		async execute(args: Record<string, unknown>): Promise<ToolResult> {
			const d = deps ?? await defaultDeps();
			let opId = typeof args.opId === "string" && args.opId ? args.opId : "";
			if (!opId) {
				const sessionId = args._sessionId ? String(args._sessionId) : "";
				if (!sessionId) return err("No session in scope and no opId given — nothing to recall.");
				const op = d.listOps().find(o => o.canonical?.sessionId === sessionId);
				if (!op) return ok("No recorded operation for this conversation yet — there is no raw history to page.");
				opId = op.id;
			}
			const rows = d.readOpMessages(opId);
			const msgs: RecallMsg[] = [];
			for (const row of rows) {
				const param = d.toChatParam(row);
				if (param) msgs.push({ row, param });
			}
			if (msgs.length === 0) return ok(`Op ${opId} has no readable messages.`);

			const cursor = typeof args.cursor === "string" && args.cursor ? args.cursor : undefined;
			const detail = args.detail === "high" ? "high" : "low";
			const rawLimit = typeof args.limit === "number" && args.limit > 0 ? Math.floor(args.limit) : DEFAULT_LIMIT;
			const limit = Math.min(rawLimit, MAX_LIMIT);
			const page = typeof args.page === "number" && Number.isFinite(args.page) ? Math.trunc(args.page) : 1;
			const partIndex = typeof args.partIndex === "number" && Number.isInteger(args.partIndex) ? args.partIndex : undefined;

			if (detail === "high") {
				let target: RecallMsg | undefined;
				if (cursor) {
					const { startId } = parseCursor(cursor);
					target = msgs.find(m => m.row.messageId === startId);
					if (!target) return err(`cursor messageId "${startId}" not found in op ${opId}'s history.`);
				} else {
					target = msgs[msgs.length - 1];
				}
				return ok(renderHigh(msgs, target, partIndex));
			}

			const res = pageMessages(msgs, { cursor, page, limit });
			if (res.error) return err(`${res.error} (op ${opId}).`);
			return ok(renderLowPage(res, opId, page === 0 ? 1 : page));
		},
	};
}

export const recallTool = createRecallTool();
