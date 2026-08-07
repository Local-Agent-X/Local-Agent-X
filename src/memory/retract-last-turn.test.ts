import type { ChatCompletionMessageParam } from "openai/resources/chat/completions.js";
import { describe, it, expect } from "vitest";

import { retractLastTurn } from "./retract-last-turn.js";
import { COMPACTION_PREFIX } from "../types.js";

const user = (content: string): ChatCompletionMessageParam => ({ role: "user", content });
const asst = (content: string): ChatCompletionMessageParam => ({ role: "assistant", content });
const tool = (content: string): ChatCompletionMessageParam =>
	({ role: "tool", content, tool_call_id: "t1" });
const compaction = (): ChatCompletionMessageParam =>
	({ role: "system", content: `${COMPACTION_PREFIX} 12 messages summarized]\ndigest\n[END COMPACTED CONTEXT]` });

describe("retractLastTurn", () => {
	it("turn mode drops the whole last turn INCLUSIVE of the user row", () => {
		const msgs = [user("hi"), asst("hello"), user("do X"), asst("did X"), tool("out")];
		const { messages, removed } = retractLastTurn(msgs, { includeUser: true });
		expect(removed).toBe(3);
		expect(messages).toEqual([user("hi"), asst("hello")]);
	});

	it("response mode keeps the last user row and drops only the trailing answer", () => {
		const msgs = [user("hi"), asst("hello"), user("do X"), asst("did X"), tool("out")];
		const { messages, removed } = retractLastTurn(msgs, { includeUser: false });
		expect(removed).toBe(2);
		expect(messages).toEqual([user("hi"), asst("hello"), user("do X")]);
	});

	it("preserves the leading compaction floor in turn mode", () => {
		const msgs = [compaction(), user("do X"), asst("did X")];
		const { messages, removed } = retractLastTurn(msgs, { includeUser: true });
		expect(removed).toBe(2);
		expect(messages).toEqual([compaction()]);
		expect(messages[0].role).toBe("system");
	});

	it("preserves the compaction floor in response mode too", () => {
		const msgs = [compaction(), user("do X"), asst("did X")];
		const { messages, removed } = retractLastTurn(msgs, { includeUser: false });
		expect(removed).toBe(1);
		expect(messages).toEqual([compaction(), user("do X")]);
	});

	it("returns unchanged when there is no user row", () => {
		const msgs = [asst("orphan assistant")];
		const { messages, removed } = retractLastTurn(msgs, { includeUser: true });
		expect(removed).toBe(0);
		expect(messages).toBe(msgs);
	});

	it("returns unchanged for a compaction-only transcript", () => {
		const msgs = [compaction()];
		const { removed } = retractLastTurn(msgs, { includeUser: true });
		expect(removed).toBe(0);
	});

	it("returns unchanged for an empty array", () => {
		const { messages, removed } = retractLastTurn([], { includeUser: true });
		expect(removed).toBe(0);
		expect(messages).toEqual([]);
	});

	it("drops a user row that carries image attachments (array content) in turn mode", () => {
		const withImage: ChatCompletionMessageParam = {
			role: "user",
			content: [
				{ type: "text", text: "look at this" },
				{ type: "image_url", image_url: { url: "data:image/png;base64,AAAA" } },
			],
		};
		const msgs = [user("earlier"), asst("ok"), withImage, asst("I see it")];
		const { messages, removed } = retractLastTurn(msgs, { includeUser: true });
		expect(removed).toBe(2);
		expect(messages).toEqual([user("earlier"), asst("ok")]);
	});

	it("response mode is a no-op when the user row is already the last row (nothing to regenerate)", () => {
		const msgs = [asst("prev"), user("do X")];
		const { messages, removed } = retractLastTurn(msgs, { includeUser: false });
		expect(removed).toBe(0);
		expect(messages).toBe(msgs);
	});

	it("does not mutate the input array", () => {
		const msgs = [user("a"), asst("b")];
		const copy = [...msgs];
		retractLastTurn(msgs, { includeUser: true });
		expect(msgs).toEqual(copy);
	});
});
