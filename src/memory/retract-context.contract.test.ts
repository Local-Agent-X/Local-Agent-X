import type { ChatCompletionMessageParam } from "openai/resources/chat/completions.js";
import { describe, it, expect } from "vitest";

// CROSS-SEAM CONTRACT (campaign integration gate).
//
// The campaign's unifying invariant is: "a polluted/last turn is recoverable so
// it stops polluting the model context." C5a shipped the RETRACT mutation
// (retractLastTurn → session.messages truncation). This test proves that
// mutation actually PROPAGATES into the NEXT turn's assembled model context by
// exercising the REAL seam with NO mocking of the modules under test:
//
//   retractLastTurn (src/memory/retract-last-turn.ts)   ← C5a, the mutation
//        │  truncated session.messages
//        ▼
//   buildCleanHistory (src/providers/sanitize.ts)       ← the canonical
//        │                                                  context-assembly
//        ▼                                                  read path that
//   assembled per-turn model context                       prepare-request.ts
//                                                           step 2 feeds the LLM
//
// buildCleanHistory is exactly what src/agent-request/prepare-request.ts calls
// (`cleanHistory = buildCleanHistory(input.sessionMessages, input.channel,
// input.maxHistory)`) to build every new turn's history. Driving the REAL
// builder off the REAL retract output ties C5a to the actual context path —
// the whole point of retract. (The full prepareAgentRequest pipeline needs a
// live server + provider resolution + memory manager; buildCleanHistory is the
// tightest real seam that assembles history without any of that, so that is
// what we exercise, unmocked.)
import { retractLastTurn } from "./retract-last-turn.js";
import { buildCleanHistory } from "../providers/sanitize.js";
import { COMPACTION_PREFIX } from "../types.js";

const user = (content: string): ChatCompletionMessageParam => ({ role: "user", content });
const asst = (content: string): ChatCompletionMessageParam => ({ role: "assistant", content });

// A leading compaction-summary system row (the immovable floor). Carries a
// unique token so we can assert it SURVIVES into the assembled context.
const COMPACTION_TOKEN = "CONSTRAINT_ALPHA_FROM_COMPACTION";
const compaction = (): ChatCompletionMessageParam => ({
	role: "system",
	content: `${COMPACTION_PREFIX} 12 messages summarized]\nEarlier the user set ${COMPACTION_TOKEN}.\n[END COMPACTED CONTEXT]`,
});

// Unique, greppable tokens for the LAST committed turn — the "polluted" turn
// the user wants gone from context.
const LAST_ASK = "POLLUTED_LAST_ASK_zqx";
const LAST_ANSWER = "POLLUTED_LAST_ANSWER_zqx";

// A transcript: compaction floor + two committed turns. The second turn is the
// one being retracted.
function transcript(): ChatCompletionMessageParam[] {
	return [
		compaction(),
		user("first question KEEP_ME_ASK"),
		asst("first answer KEEP_ME_ANSWER"),
		user(LAST_ASK),
		asst(LAST_ANSWER),
	];
}

// Flatten an assembled context to one searchable string. Content can be a
// string or a multi-part array (image turns), so serialize defensively.
function serialize(ctx: ChatCompletionMessageParam[]): string {
	return ctx
		.map((m) => (typeof m.content === "string" ? m.content : JSON.stringify(m.content)))
		.join("\n");
}

describe("retract → context contract (C5a propagates into next-turn model context)", () => {
	it("CAN-FAIL guard: WITHOUT retract, the polluted turn IS in the assembled context", () => {
		// This is the anti-tautology proof. If retract were a no-op (or the seam
		// were mocked), the polluted tokens would still reach the model. This
		// assertion documents the baseline the real fix must change.
		const contextNoRetract = buildCleanHistory(transcript(), "web");
		const flat = serialize(contextNoRetract);
		expect(flat).toContain(LAST_ASK);
		expect(flat).toContain(LAST_ANSWER);
	});

	it("turn mode: the retracted turn is EXCLUDED from context and the compaction floor is PRESERVED", () => {
		const msgs = transcript();

		// (a) REAL retract mutation (drop-last / edit-resend: user row inclusive).
		const { messages: truncated, removed } = retractLastTurn(msgs, { includeUser: true });
		expect(removed).toBe(2); // dropped the last user + its assistant answer

		// (b) Feed the truncated session.messages through the REAL context builder
		// — the exact call prepare-request.ts makes to seed the next turn.
		const context = buildCleanHistory(truncated, "web");
		const flat = serialize(context);

		// The polluted turn no longer reaches the model.
		expect(flat).not.toContain(LAST_ASK);
		expect(flat).not.toContain(LAST_ANSWER);

		// The compaction floor survived as the leading system row (its constraint
		// is still in context — retract must not cost us the summarized history).
		expect(context[0].role).toBe("system");
		expect(typeof context[0].content === "string" && context[0].content.startsWith(COMPACTION_PREFIX)).toBe(true);
		expect(flat).toContain(COMPACTION_TOKEN);

		// The kept earlier turn is still present.
		expect(flat).toContain("KEEP_ME_ASK");
		expect(flat).toContain("KEEP_ME_ANSWER");
	});

	it("response mode: only the trailing answer is EXCLUDED; the ask is kept for regeneration", () => {
		const msgs = transcript();

		// REAL retract mutation (regenerate: keep the last user row, drop its answer).
		const { messages: truncated, removed } = retractLastTurn(msgs, { includeUser: false });
		expect(removed).toBe(1);

		const context = buildCleanHistory(truncated, "web");
		const flat = serialize(context);

		// The stale answer is gone from context…
		expect(flat).not.toContain(LAST_ANSWER);
		// …but the ask remains so the next turn regenerates against it.
		expect(flat).toContain(LAST_ASK);

		// Compaction floor still intact.
		expect(context[0].role).toBe("system");
		expect(flat).toContain(COMPACTION_TOKEN);
	});
});
