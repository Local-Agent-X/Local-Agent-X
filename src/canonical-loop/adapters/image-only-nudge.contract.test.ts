// Cross-seam contract for the 2026-08-31 Anthropic 400 "text content blocks
// must be non-empty" and its sibling fixes. Drives the REAL seams end to end:
//
//   op_messages on disk → buildTurnInput (digest = its own trailing user row)
//     → canonicalToTransport → transport→ChatCompletion (mirrored below)
//     → anthropic-client convertMessages   |   codex convertMessagesToInput
//
// Pinned fixes:
//   C1  images-to-openai-parts.ts omits the empty leading text part
//   C2  anthropic-client/request.ts convertUserContent drops empty text blocks
//   C21 images-to-openai-parts.ts emits a non-empty note for an unreadable file
//   C22 gemini-native-transport.ts adapts user rows through the SAME converter
//       (it used to drop /uploads images and emit {text:""} — the identical
//       empty-text class on the Gemini path)
//   C3  canonical-run.ts writes an `_error` boundary row; providers/sanitize.ts
//       renders it once and strips the flag before any provider sees it
//
// Every assertion is on the wire shape — no snapshots.
import { describe, it, expect, beforeEach, afterEach, afterAll } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ChatCompletionMessageParam } from "openai/resources/chat/completions.js";
import type { Op } from "../../ops/types.js";
import type { OpMessageRow } from "../types.js";
import type { TransportMessage } from "./anthropic.js";
import type { AnthropicContent, AnthropicMessage } from "../../anthropic-client/types.js";
import { appendOpMessage } from "../store.js";
import { buildTurnInput } from "../turn-loop/build-input.js";
import { appendNudgeAsUserMessage } from "../turn-loop/nudges.js";
import { canonicalToTransport } from "./canonical-to-transport.js";
import { imagesToOpenAIParts } from "./images-to-openai-parts.js";
import { toGeminiContents } from "./gemini-native-transport.js";
import { convertMessages } from "../../anthropic-client/request.js";
import { convertMessagesToInput } from "../../codex-message-convert.js";
import {
	buildCleanHistory,
	renderTurnErrorBoundary,
	TURN_ERROR_BOUNDARY_HEAD,
} from "../../providers/sanitize.js";

// Minimal valid 1x1 transparent PNG.
const PNG_B64 =
	"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";
const PNG_DATA_URL = `data:image/png;base64,${PNG_B64}`;
const IMAGE_BLOCK = { type: "image", source: { type: "base64", media_type: "image/png", data: PNG_B64 } };
const NUDGE = "You claimed an action you did not take. Answer the user directly.";
const DIGEST_OPEN = "[SITUATIONAL CONTEXT";
const UNREADABLE_NOTE = "[Attachment shot.png could not be read (ENOENT)]";

// Stand-in for ~/.lax/uploads. HOME is already a throwaway (test/setup/
// test-env.ts), so op_messages never touch the developer's real ~/.lax.
const uploads = mkdtempSync(join(tmpdir(), "lax-c19-uploads-"));
const SHOT_PATH = join(uploads, "shot.png");
const MISSING_PATH = join(uploads, "gone.png");
writeFileSync(SHOT_PATH, Buffer.from(PNG_B64, "base64"));
afterAll(() => rmSync(uploads, { recursive: true, force: true }));

// Unique opId per test = no cross-test bleed in op_messages. No per-op rmSync:
// the ops root lives under the throwaway HOME test/setup/test-env.ts creates
// and removes, and `opDir` (ops/event-log.js) is on the adapter-sandbox
// forbidden-import list this directory is audited against
// (test/canonical-loop-11-boundary-audit.test.ts).
let opSeq = 0;
let opId = "";
beforeEach(() => { opId = `op_c19_contract_${opSeq++}`; });

// Interactive chat_turn op — the lane build-input.ts appends the digest on.
function op(): Op {
	return { id: opId, type: "chat_turn", task: "look at this", lane: "interactive" } as unknown as Op;
}

function row(r: Omit<OpMessageRow, "opId" | "createdAt">): void {
	appendOpMessage({ ...r, opId, createdAt: "2026-08-31T23:00:00.000Z" });
}

// The exact row chat-runner/seed-messages.ts persists for a caption-less
// send: `{ text: "", images: prepared.images }` where prepared.images is
// agent-request/attachments.ts output — `{ name, url: "/uploads/<f>", filePath }`.
function seedImageOnlyUser(filePath: string): void {
	row({
		messageId: "u-0", turnIdx: 0, seqInTurn: 0, role: "user",
		content: { text: "", images: [{ name: "shot.png", url: "/uploads/shot.png", filePath }] },
	});
}
function seedAssistantReply(): void {
	row({ messageId: "a-0", turnIdx: 0, seqInTurn: 1, role: "assistant", content: { text: "Looking at it." } });
}

// Mirrors the module-private anthropic-transport.ts toOpenAiMessage and
// codex-transport.ts toOaiMessage — byte-identical for the roles replayed here
// (both hand user rows with images to the shared imagesToOpenAIParts).
function toChatParam(m: TransportMessage): ChatCompletionMessageParam {
	if (m.role === "user" && m.images && m.images.length > 0) {
		return { role: "user", content: imagesToOpenAIParts(m.content, m.images) } as ChatCompletionMessageParam;
	}
	if (m.role === "tool") {
		return { role: "tool", tool_call_id: m.toolCallId ?? "tc-unknown", content: m.content } as ChatCompletionMessageParam;
	}
	return { role: m.role, content: m.content } as ChatCompletionMessageParam;
}

// buildTurnInput → canonicalToTransport → ChatCompletion params, from disk.
async function pipeline(turnIdx: number): Promise<{ transport: TransportMessage[]; params: ChatCompletionMessageParam[] }> {
	const input = await buildTurnInput(op(), turnIdx, null);
	const transport = canonicalToTransport(input.messages, input.pendingRedirect);
	return { transport, params: transport.map(toChatParam) };
}

type TextBlock = Extract<AnthropicContent, { type: "text" }>;
function blocksOf(m: AnthropicMessage): AnthropicContent[] {
	return typeof m.content === "string" ? [{ type: "text", text: m.content }] : m.content;
}
function textBlocks(m: AnthropicMessage): TextBlock[] {
	return blocksOf(m).filter((b): b is TextBlock => b.type === "text");
}

// The Messages API invariant: every text block has non-whitespace text and
// every message has at least one block.
function assertAnthropicWellFormed(wire: AnthropicMessage[]): void {
	expect(wire.length).toBeGreaterThan(0);
	for (const m of wire) {
		if (typeof m.content === "string") {
			expect(m.content.trim().length, JSON.stringify(m)).toBeGreaterThan(0);
			continue;
		}
		expect(m.content.length, JSON.stringify(m)).toBeGreaterThan(0);
		for (const b of m.content) {
			if (b.type === "text") expect(b.text.trim().length, JSON.stringify(b)).toBeGreaterThan(0);
		}
	}
	expect(JSON.stringify(wire)).not.toContain('{"type":"text","text":""}');
}

type CodexPart = { type: string; text?: string; image_url?: string; detail?: string };
type CodexItem = { type: string; role?: string; content?: CodexPart[] };
function codexItems(params: ChatCompletionMessageParam[]): CodexItem[] {
	return convertMessagesToInput(params) as CodexItem[];
}
function assertCodexWellFormed(items: CodexItem[]): void {
	expect(items.length).toBeGreaterThan(0);
	for (const item of items) {
		if (item.type !== "message" || item.role !== "user") continue;
		expect(item.content?.length ?? 0, JSON.stringify(item)).toBeGreaterThan(0);
		for (const p of item.content ?? []) {
			if (p.type === "input_text") expect((p.text ?? "").trim().length, JSON.stringify(p)).toBeGreaterThan(0);
		}
	}
}

describe("A. image-only user row + middleware nudge → Anthropic Messages wire", () => {
	// The digest is now its OWN trailing row (cache-prefix stability), so it no
	// longer papers over the image row's empty caption — the C1/C2 omission is
	// what keeps `{type:"text",text:""}` off the wire here, on EVERY turn rather
	// than only turn 0.
	it("first request of the turn: the image row carries no empty caption block and the digest is a separate trailing row", async () => {
		seedImageOnlyUser(SHOT_PATH);
		const { transport, params } = await pipeline(1);
		// Premise: the persisted caption is "" and the image survives the transport seam.
		expect(transport).toHaveLength(2);
		expect(transport[0].images).toEqual([{ name: "shot.png", url: "/uploads/shot.png", filePath: SHOT_PATH }]);
		expect(transport[0].content).toBe("");
		expect(transport[1].content).toContain(DIGEST_OPEN);
		expect(transport[1].images).toBeUndefined();

		const wire = convertMessages(params);
		assertAnthropicWellFormed(wire);
		expect(wire.map(m => m.role)).toEqual(["user", "user"]);
		const blocks = blocksOf(wire[0]);
		expect(blocks.map(b => b.type)).toEqual(["image", "text"]);
		expect(blocks[0]).toEqual(IMAGE_BLOCK);
		expect((blocks[1] as TextBlock).text).toContain(SHOT_PATH); // on-disk path hint
		expect(JSON.stringify(blocks)).not.toContain(DIGEST_OPEN);
		expect(textBlocks(wire[1])[0].text).toContain(DIGEST_OPEN);
	});

	it("turn 0 has no digest yet: the empty caption is omitted rather than sent as an empty text block", async () => {
		seedImageOnlyUser(SHOT_PATH);
		const { transport, params } = await pipeline(0);
		expect(transport[0].content).toBe("");
		const wire = convertMessages(params);
		assertAnthropicWellFormed(wire);
		expect(blocksOf(wire[0]).map(b => b.type)).toEqual(["image", "text"]);
	});

	it("after the nudge the image row is no longer last: no empty block, image intact, nudge is the last user message", async () => {
		seedImageOnlyUser(SHOT_PATH);
		seedAssistantReply();
		expect(appendNudgeAsUserMessage(opId, 1, NUDGE)).toBe(true);

		const { transport, params } = await pipeline(1);
		// Premise: the image row's text is EMPTY — exactly the
		// `{type:"text",text:""}` that reached the API pre-fix. The digest lands
		// on the trailing user row: the nudge is persisted history and the digest
		// is the ephemeral tail, but they SHARE a row, because two user rows in a
		// row is the shape codex/gemini return empty responses on (F5). The row
		// is still the last one, so it is still the volatile tail the cache
		// breakpoint sits beneath.
		expect(transport.map(m => m.role)).toEqual(["user", "assistant", "user"]);
		expect(transport[0].content).toBe("");
		expect(transport[2].content).toContain(NUDGE);
		expect(transport[2].content).toContain(DIGEST_OPEN);

		const wire = convertMessages(params);
		assertAnthropicWellFormed(wire);
		expect(wire.map(m => m.role)).toEqual(["user", "assistant", "user"]);
		const first = blocksOf(wire[0]);
		expect(first.map(b => b.type)).toEqual(["image", "text"]); // caption omitted; image + path hint kept
		expect(first[0]).toEqual(IMAGE_BLOCK);
		expect(JSON.stringify(first)).not.toContain(DIGEST_OPEN);
		expect(JSON.stringify(first)).not.toContain("[empty message]");
		const last = wire[wire.length - 1];
		expect(last.role).toBe("user");
		expect(typeof last.content).toBe("string");
		expect(last.content as string).toContain(DIGEST_OPEN);
		expect(last.content as string).toContain(NUDGE);
	});
});

describe("B. the same two histories → Codex Responses input", () => {
	it("before the nudge: no empty input_text, the image arrives as input_image", async () => {
		seedImageOnlyUser(SHOT_PATH);
		const items = codexItems((await pipeline(1)).params);
		assertCodexWellFormed(items);
		const users = items.filter(i => i.type === "message" && i.role === "user");
		expect(users).toHaveLength(2); // image row + the ephemeral digest row
		expect(users[0].content!.map(p => p.type)).toEqual(["input_image", "input_text"]);
		expect(users[0].content![0]).toEqual({ type: "input_image", image_url: PNG_DATA_URL, detail: "auto" });
		expect(users[1].content![0].text).toContain(DIGEST_OPEN);
	});

	it("after the nudge: the image row keeps its input_image with no empty input_text; the nudge is the last user item", async () => {
		seedImageOnlyUser(SHOT_PATH);
		seedAssistantReply();
		appendNudgeAsUserMessage(opId, 1, NUDGE);
		const items = codexItems((await pipeline(1)).params);
		assertCodexWellFormed(items);
		// No user-only RUN reaches codex: the digest shares the nudge's row
		// (F5 — a run of user items is what makes this endpoint answer empty).
		expect(items.map(i => `${i.type}:${i.role ?? ""}`)).toEqual([
			"message:user", "message:assistant", "message:user",
		]);
		expect(items[0].content!.map(p => p.type)).toEqual(["input_image", "input_text"]);
		expect(items[0].content![0]).toEqual({ type: "input_image", image_url: PNG_DATA_URL, detail: "auto" });
		const last = items[items.length - 1];
		expect(last.content).toHaveLength(1);
		expect(last.content![0].type).toBe("input_text");
		expect(last.content![0].text).toContain(NUDGE);
		expect(last.content![0].text).toContain(DIGEST_OPEN);
	});
});

describe("E. the same two histories → Gemini native contents (C22)", () => {
	const INLINE_PART = { inlineData: { mimeType: "image/png", data: PNG_B64 } };

	it("before the nudge: inlineData + path hint — the /uploads image reaches the wire, no {text:''}", async () => {
		seedImageOnlyUser(SHOT_PATH);
		const contents = toGeminiContents((await pipeline(1)).transport);
		expect(contents).toHaveLength(2);
		expect(contents.map(c => c.role)).toEqual(["user", "user"]);
		expect(contents[0].parts).toHaveLength(2);
		expect(contents[0].parts[0]).toEqual(INLINE_PART);
		expect((contents[0].parts[1] as { text: string }).text).toContain(SHOT_PATH);
		expect((contents[1].parts[0] as { text: string }).text).toContain(DIGEST_OPEN);
		expect(JSON.stringify(contents)).not.toContain('"text":""');
	});

	it("after the nudge the image row keeps its inlineData with no empty text part; the nudge is the last user turn", async () => {
		seedImageOnlyUser(SHOT_PATH);
		seedAssistantReply();
		appendNudgeAsUserMessage(opId, 1, NUDGE);
		const contents = toGeminiContents((await pipeline(1)).transport);
		expect(contents.map(c => c.role)).toEqual(["user", "model", "user"]);
		// Pre-fix: dataUrlToInline("/uploads/shot.png") → null, so this row was
		// [{text:""}] — image dropped AND the empty-text class, both at once.
		expect(contents[0].parts).toHaveLength(2);
		expect(contents[0].parts[0]).toEqual(INLINE_PART);
		expect((contents[0].parts[1] as { text: string }).text).toContain(SHOT_PATH);
		// Nudge + digest share the trailing turn (F5): no user/user run.
		const lastParts = contents[2].parts as Array<{ text: string }>;
		expect(lastParts).toHaveLength(1);
		expect(lastParts[0].text).toContain(NUDGE);
		expect(lastParts[0].text).toContain(DIGEST_OPEN);
		expect(JSON.stringify(contents)).not.toContain('"text":""');
	});

	it("unreadable upload: the byte-identical C21 note, no inlineData, no leaked path", async () => {
		seedImageOnlyUser(MISSING_PATH);
		seedAssistantReply();
		appendNudgeAsUserMessage(opId, 1, NUDGE);
		const contents = toGeminiContents((await pipeline(1)).transport);
		expect(contents.map(c => c.role)).toEqual(["user", "model", "user"]);
		expect(contents[0].parts).toEqual([{ text: UNREADABLE_NOTE }]);
		const json = JSON.stringify(contents);
		expect(json).not.toContain("inlineData");
		expect(json).not.toContain(MISSING_PATH);
		expect(json).not.toContain('"text":""');
	});
});

describe("C. unreadable upload (C21) → a non-empty note, never an image block, never a leaked path", () => {
	it("first request: exactly one 'could not be read' text block for the row, no image block", async () => {
		seedImageOnlyUser(MISSING_PATH);
		const wire = convertMessages((await pipeline(1)).params);
		assertAnthropicWellFormed(wire);
		expect(wire).toHaveLength(2); // image row + the ephemeral digest row
		const blocks = blocksOf(wire[0]);
		expect(blocks.filter(b => b.type === "image")).toHaveLength(0);
		const notes = textBlocks(wire[0]).filter(b => b.text.includes("could not be read"));
		expect(notes).toHaveLength(1);
		expect(notes[0].text).toBe(UNREADABLE_NOTE);
		// The note is the row's ONLY block — no empty caption, no on-disk hint
		// (there is no readable file to point at), and no digest folded in.
		expect(blocks.map(b => b.type)).toEqual(["text"]);
		expect(textBlocks(wire[1])[0].text).toContain(DIGEST_OPEN);
		expect(JSON.stringify(wire)).not.toContain(MISSING_PATH);
	});

	it("after the nudge the note is the row's ONLY block — the row is neither empty nor an '[empty message]' stand-in", async () => {
		seedImageOnlyUser(MISSING_PATH);
		seedAssistantReply();
		appendNudgeAsUserMessage(opId, 1, NUDGE);
		const { params } = await pipeline(1);

		const wire = convertMessages(params);
		assertAnthropicWellFormed(wire);
		expect(wire.map(m => m.role)).toEqual(["user", "assistant", "user"]); // nudge + digest share the tail (F5)
		expect(blocksOf(wire[0])).toEqual([{ type: "text", text: UNREADABLE_NOTE }]);
		expect(JSON.stringify(wire)).not.toContain("[empty message]");
		expect(JSON.stringify(wire)).not.toContain(MISSING_PATH);

		const items = codexItems(params);
		assertCodexWellFormed(items);
		expect(items[0].content).toEqual([{ type: "input_text", text: UNREADABLE_NOTE }]);
	});
});

describe("D. error-boundary history (C3) → Anthropic: alternating roles, boundary rendered once, flag stripped", () => {
	const ERR = { code: "http_400", message: "text content blocks must be non-empty" };
	const BOUNDARY = renderTurnErrorBoundary(ERR);
	const Q: ChatCompletionMessageParam = { role: "user", content: "summarize the screenshot" };
	const FOLLOW: ChatCompletionMessageParam = { role: "user", content: "what happened?" };
	// The exact row canonical-run.ts persistTurnState writes on a terminal error.
	function errorRow(): ChatCompletionMessageParam {
		return { role: "assistant", content: BOUNDARY, _error: { ...ERR } } as unknown as ChatCompletionMessageParam;
	}

	function replay(rows: ChatCompletionMessageParam[]): AnthropicMessage[] {
		const before = structuredClone(rows);
		const clean = buildCleanHistory(rows, "web");
		const wire = convertMessages(clean);
		assertAnthropicWellFormed(wire);
		for (let i = 1; i < wire.length; i++) {
			expect(wire[i].role, `wire[${i - 1}] and wire[${i}] share a role`).not.toBe(wire[i - 1].role);
		}
		expect(wire[wire.length - 1]).toEqual({ role: "user", content: "what happened?" });
		const json = JSON.stringify(wire);
		expect(json.split(TURN_ERROR_BOUNDARY_HEAD).length - 1).toBe(1);
		expect(json).not.toContain("_error");
		expect(JSON.stringify(clean)).not.toContain("_error");
		// The stored history is untouched — sanitize works on copies.
		expect(rows).toEqual(before);
		expect((rows.find(r => r.role === "assistant" && r.content === BOUNDARY) as unknown as { _error?: unknown })._error)
			.toEqual(ERR);
		return wire;
	}

	it("(i) 400 shape: [user, _error boundary, user]", () => {
		const wire = replay([Q, errorRow(), FOLLOW]);
		expect(wire.map(m => m.role)).toEqual(["user", "assistant", "user"]);
		expect(blocksOf(wire[1])).toEqual([{ type: "text", text: BOUNDARY }]);
	});

	it("(ii) partial-text shape: [user, partial assistant, _error boundary, user] coalesces into one assistant turn", () => {
		const wire = replay([Q, { role: "assistant", content: "Starting on it." }, errorRow(), FOLLOW]);
		expect(wire.map(m => m.role)).toEqual(["user", "assistant", "user"]);
		const texts = textBlocks(wire[1]);
		expect(texts).toHaveLength(1);
		expect(texts[0].text.startsWith("Starting on it.")).toBe(true);
		expect(texts[0].text.endsWith(BOUNDARY)).toBe(true);
	});
});
