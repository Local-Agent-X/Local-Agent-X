/**
 * Persist-profile hygiene at the persistTurnState seam (chunk of the
 * model-output sanitizer rollout — providers/output-sanitize.ts).
 *
 * Guarantees pinned here:
 *  - a turn whose final text carries small-local-model junk (leaked template
 *    tokens, hallucinated tool markup, stray closers) stores CLEAN text — in
 *    session.messages and in what memoryManager.persistTurn receives;
 *  - model speech is the ONLY thing sanitized: user rows and tool rows keep
 *    their exact bytes (a tool result legitimately containing `<think>` must
 *    persist verbatim), and assistant tool_calls structures survive;
 *  - the _interrupted boundary row (providers/sanitize.ts's
 *    INTERRUPTED_TURN_BOUNDARY) is preserved verbatim WITH its structural
 *    flag — the hygiene pass composes with the control-marker invariant,
 *    never replaces it;
 *  - clean text is byte-identical in the store (no-change fast path).
 *
 * Sibling test so the vi.mock specifiers match canonical-run.ts's own
 * import paths. The canonical-loop barrel is mocked ONLY to feed fixture
 * rows to readOpMessages — row→param conversion runs the REAL
 * opMessageRowToChatParam so the sanitizer is tested against true shapes.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import type { ChatCompletionMessageParam } from "openai/resources/chat/completions.js";
import type { Session } from "../../../types.js";

const { fixtureRowsByOp } = vi.hoisted(() => ({
	fixtureRowsByOp: new Map<string, unknown[]>(),
}));

vi.mock("../../../canonical-loop/index.js", async () => {
	const real = await vi.importActual<typeof import("../../../canonical-loop/public/message-convert.js")>(
		"../../../canonical-loop/public/message-convert.js",
	);
	return {
		readOpMessages: (opId: string) => fixtureRowsByOp.get(opId) ?? [],
		opMessageRowToChatParam: real.opMessageRowToChatParam,
	};
});

import { persistTurnState } from "./canonical-run.js";
import { INTERRUPTED_TURN_BOUNDARY } from "../../../providers/sanitize.js";

let seq = 0;
function freshInput(opts: { assistantText: string; canonicalOpId?: string; interrupted?: boolean }) {
	const session = { messages: [], updatedAt: 0 } as unknown as Session;
	const persistTurn = vi.fn(async (_input: unknown) => {});
	const ctx = {
		memoryManager: { persistTurn },
		saveSession: vi.fn(),
	};
	const input: Parameters<typeof persistTurnState>[0] = {
		canonicalOpId: opts.canonicalOpId ?? "",
		message: "set my reminder for the store opening",
		assistantText: opts.assistantText,
		session,
		ctx: ctx as never,
		sessionId: `sess-persist-hygiene-${seq++}`,
		images: [],
		interrupted: opts.interrupted === true,
	};
	return { session, ctx, persistTurn, input };
}

// Long enough to clear output-sanitize's 80-char repeat-collapse floor and
// junk-laden in the exact shape of the 2026-07 incident (stray closer +
// fabricated tool block).
const CLEAN_REPLY =
	"Alright — the reminder is set for eight forty-five, fifteen minutes before the store opens tomorrow.";
const JUNK_REPLY = `${CLEAN_REPLY}</blockquote>\n<execute_tool>\nNone\n</execute_tool>`;

beforeEach(() => {
	fixtureRowsByOp.clear();
});

describe("persistTurnState — persist-profile hygiene (fallback path, no op rows)", () => {
	it("stores clean text and feeds memory clean when the final text carries junk", async () => {
		const { session, ctx, persistTurn, input } = freshInput({ assistantText: JUNK_REPLY });
		await persistTurnState(input);

		expect(session.messages).toHaveLength(2);
		expect(session.messages[0]).toMatchObject({ role: "user", content: input.message });
		expect(session.messages[1]).toEqual({ role: "assistant", content: CLEAN_REPLY });
		expect(persistTurn).toHaveBeenCalledTimes(1);
		expect(persistTurn.mock.calls[0][0]).toMatchObject({ agentResponse: CLEAN_REPLY });
		expect(ctx.saveSession).toHaveBeenCalledWith(session);
	});

	it("clean text is byte-identical in the store and in memory (no-change fast path)", async () => {
		const { session, persistTurn, input } = freshInput({ assistantText: CLEAN_REPLY });
		await persistTurnState(input);

		const assistant = session.messages[1] as { content: string };
		expect(assistant.content).toBe(CLEAN_REPLY);
		expect(persistTurn.mock.calls[0][0]).toMatchObject({ agentResponse: CLEAN_REPLY });
	});

	it("junk-only text persists nothing rather than junk (user turn still saved)", async () => {
		const { session, persistTurn, input } = freshInput({ assistantText: "<|im_end|>" });
		await persistTurnState(input);

		expect(session.messages).toHaveLength(1);
		expect(session.messages[0]).toMatchObject({ role: "user" });
		expect(persistTurn).not.toHaveBeenCalled();
	});

	it("interrupted turn: cleaned text first, then the boundary row verbatim with _interrupted intact", async () => {
		const { session, input } = freshInput({ assistantText: JUNK_REPLY, interrupted: true });
		await persistTurnState(input);

		expect(session.messages).toHaveLength(3);
		expect(session.messages[1]).toEqual({ role: "assistant", content: CLEAN_REPLY });
		const boundary = session.messages[2] as { content: string; _interrupted?: boolean };
		expect(boundary.content).toBe(INTERRUPTED_TURN_BOUNDARY);
		expect(boundary._interrupted).toBe(true);
	});
});

describe("persistTurnState — persist-profile hygiene (committed op rows)", () => {
	it("sanitizes assistant speech per complete row; user/tool rows keep exact bytes; tool_calls survive", async () => {
		const TOOL_RESULT_BYTES = "file says <think>keep me verbatim</think> and <|im_end|> is data here";
		fixtureRowsByOp.set("op-hygiene-1", [
			{ messageId: "hist-0", role: "user", content: { text: "old history — must be skipped" } },
			{ messageId: "m1", role: "user", content: { text: "check the schedule" } },
			{
				messageId: "m2",
				role: "assistant",
				content: {
					text: "Sure.<|im_end|>",
					toolCalls: [{ id: "tc1", name: "bash", arguments: "{}" }],
				},
			},
			{ messageId: "m3", role: "tool_result", content: { toolCallId: "tc1", result: TOOL_RESULT_BYTES } },
			{ messageId: "m4", role: "assistant", content: { text: JUNK_REPLY } },
		]);
		const { session, persistTurn, input } = freshInput({
			canonicalOpId: "op-hygiene-1",
			assistantText: `Sure.${CLEAN_REPLY}`, // accumulated stream, already token-free here
		});
		await persistTurnState(input);

		const msgs = session.messages as ChatCompletionMessageParam[];
		expect(msgs).toHaveLength(4);
		expect(msgs[0]).toMatchObject({ role: "user", content: "check the schedule" });
		// Assistant tool-call row: text cleaned, structured calls untouched.
		expect(msgs[1]).toMatchObject({
			role: "assistant",
			content: "Sure.",
			tool_calls: [{ id: "tc1", type: "function", function: { name: "bash", arguments: "{}" } }],
		});
		// Tool result row: NOT model speech — exact bytes preserved.
		expect(msgs[2]).toMatchObject({ role: "tool", tool_call_id: "tc1", content: TOOL_RESULT_BYTES });
		// Final assistant row: incident junk gone.
		expect(msgs[3]).toEqual({ role: "assistant", content: CLEAN_REPLY });
		// Memory gets the sanitized accumulated text.
		expect(persistTurn.mock.calls[0][0]).toMatchObject({ agentResponse: `Sure.${CLEAN_REPLY}` });
	});

	it("clean rows persist byte-identical (no-change fast path over the row path)", async () => {
		fixtureRowsByOp.set("op-hygiene-2", [
			{ messageId: "m1", role: "user", content: { text: "hi" } },
			{ messageId: "m2", role: "assistant", content: { text: CLEAN_REPLY } },
		]);
		const { session, input } = freshInput({ canonicalOpId: "op-hygiene-2", assistantText: CLEAN_REPLY });
		await persistTurnState(input);

		const assistant = session.messages[1] as { content: string };
		expect(assistant.content).toBe(CLEAN_REPLY);
	});
});
