/**
 * Delivery hygiene at the wrappedOnEvent seam (chunk of the model-output
 * sanitizer rollout — providers/output-sanitize.ts).
 *
 * Policy under test (E2): live assistant STREAM DELTAS get only the cheap
 * stateless special-token strip; the FULL delivery pass runs at the two
 * final-text boundaries — adapter `replace` events, and the `done` intercept,
 * which repairs the client's accumulated text with ONE synthetic replace
 * emitted before done, ONLY when the pass changed something. The client
 * (public/js/chat-stream-reducer.js) renders accumulated deltas and gets no
 * other final-text event, so the intercept's mirror must reproduce the
 * reducer's own content edits byte-exactly: the "\n\n" paragraph break it
 * inserts after tool events and the "\n\nError: …" it appends on error
 * events. Everything that is not assistant answer text — reasoning lane,
 * tool lifecycle, approvals, stopped, heartbeats — must pass through by
 * REFERENCE (blast-radius: wrappedOnEvent forwards every event type).
 *
 * Sibling test so the vi.mock specifiers match event-wiring.ts's own
 * import paths.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import type { ServerEvent } from "../../../types.js";

const { checkOutputMock } = vi.hoisted(() => ({
	checkOutputMock: vi.fn((_text: string): unknown => null),
}));

// ThreatEngine's real constructor opens the shared audit trail on dataDir;
// the canary behavior itself is pinned here through checkOutputMock.
vi.mock("../../../threat/threat-engine.js", () => ({
	ThreatEngine: class {
		checkOutput(text: string) { return checkOutputMock(text); }
		markUserConsentFlow() {}
	},
}));
vi.mock("../../../threat/consent-store.js", () => ({
	grantConsent: vi.fn(),
	getActiveConsent: vi.fn(() => null),
}));
vi.mock("../system-prompt-augmentations.js", () => ({
	augmentSystemPrompt: vi.fn(async () => {}),
}));

import { installEventWiring } from "./event-wiring.js";

async function makeWiring() {
	const sse: ServerEvent[] = [];
	const ws: ServerEvent[] = [];
	const abortController = new AbortController();
	const ctx = {
		chatWs: {
			startChat: vi.fn(() => ({
				abort: new AbortController(),
				onEvent: (ev: ServerEvent) => ws.push(ev),
			})),
		},
		setActiveOnEvent: vi.fn(),
		setActiveBrowserSessionId: vi.fn(),
		setActiveRuntime: vi.fn(),
		dataDir: "unused-threat-engine-mocked",
	};
	const wiring = await installEventWiring({
		sessionId: "sess-wiring-test",
		message: "hello",
		attachments: [],
		prepared: { provider: "xai", model: "grok", tools: [], images: [] } as never,
		ctx: ctx as never,
		emitSse: (ev) => sse.push(ev),
		abortController,
		onChatRegistered: () => {},
	});
	return { wiring, sse, ws, abortController };
}

const DONE: ServerEvent = { type: "done", usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 } };

beforeEach(() => {
	checkOutputMock.mockReset();
	checkOutputMock.mockReturnValue(null);
});

describe("wrappedOnEvent — live delta strip (streaming profile)", () => {
	it("strips a leaked special token from an answer delta; the original event is not mutated", async () => {
		const { wiring, ws } = await makeWiring();
		const ev: ServerEvent = { type: "stream", delta: "Hello<|im_end|>" };
		wiring.wrappedOnEvent(ev);
		expect(ws).toHaveLength(1);
		expect(ws[0]).toEqual({ type: "stream", delta: "Hello" });
		expect(ws[0]).not.toBe(ev); // forwarded as a new object…
		expect(ev.delta).toBe("Hello<|im_end|>"); // …the original stays intact
		// The accumulator keeps RAW text — the canary and the persist-side pass
		// both see what the model actually said.
		expect(wiring.getFullResponseText()).toBe("Hello<|im_end|>");
	});

	it("forwards clean deltas by reference (no-change fast path)", async () => {
		const { wiring, ws } = await makeWiring();
		const ev: ServerEvent = { type: "stream", delta: "plain text" };
		wiring.wrappedOnEvent(ev);
		expect(ws[0]).toBe(ev);
	});

	it("drops a junk-only delta instead of forwarding empty text", async () => {
		const { wiring, ws } = await makeWiring();
		wiring.wrappedOnEvent({ type: "stream", delta: "<|im_end|>" });
		expect(ws).toHaveLength(0);
		wiring.wrappedOnEvent({ type: "stream", delta: "Hi" });
		wiring.wrappedOnEvent(DONE);
		// "Hi" is clean → no repair replace either.
		expect(ws.map((e) => e.type)).toEqual(["stream", "done"]);
	});

	it("reasoning deltas are NOT sanitized — same reference through", async () => {
		const { wiring, ws } = await makeWiring();
		const ev: ServerEvent = { type: "reasoning", delta: "<|im_end|><think>raw chain-of-thought" };
		wiring.wrappedOnEvent(ev);
		expect(ws[0]).toBe(ev);
	});
});

describe("wrappedOnEvent — replace events get the full delivery pass", () => {
	it("sanitizes an adapter replace wholesale", async () => {
		const { wiring, ws } = await makeWiring();
		const ev: ServerEvent = { type: "stream", replace: true, text: "<think>internal</think>The answer is 4." };
		wiring.wrappedOnEvent(ev);
		expect(ws[0]).toEqual({ type: "stream", replace: true, text: "The answer is 4." });
		expect((ev as { text: string }).text).toBe("<think>internal</think>The answer is 4.");
	});

	it("clean replace passes through by reference and needs no repair at done", async () => {
		const { wiring, ws } = await makeWiring();
		const ev: ServerEvent = { type: "stream", replace: true, text: "All good." };
		wiring.wrappedOnEvent(ev);
		wiring.wrappedOnEvent(DONE);
		expect(ws[0]).toBe(ev);
		expect(ws.map((e) => e.type)).toEqual(["stream", "done"]);
	});
});

describe("wrappedOnEvent — final-text repair at done", () => {
	it("a token split across deltas is repaired by ONE replace emitted before done", async () => {
		const { wiring, ws, sse } = await makeWiring();
		wiring.wrappedOnEvent({ type: "stream", delta: "<|im_en" }); // stateless strip can't see it
		wiring.wrappedOnEvent({ type: "stream", delta: "d|>Hi." });
		wiring.wrappedOnEvent(DONE);
		expect(ws.map((e) => e.type)).toEqual(["stream", "stream", "stream", "done"]);
		expect(ws[2]).toEqual({ type: "stream", replace: true, text: "Hi." });
		// Both channels carry the identical sequence (onEvent = emitSse + ws).
		expect(sse).toEqual(ws);
	});

	it("clean turn fast path: no synthetic replace, done forwarded by reference", async () => {
		const { wiring, ws } = await makeWiring();
		const d1: ServerEvent = { type: "stream", delta: "Hello " };
		const d2: ServerEvent = { type: "stream", delta: "world" };
		wiring.wrappedOnEvent(d1);
		wiring.wrappedOnEvent(d2);
		wiring.wrappedOnEvent(DONE);
		expect(ws).toHaveLength(3);
		expect(ws[0]).toBe(d1);
		expect(ws[1]).toBe(d2);
		expect(ws[2]).toBe(DONE);
	});

	it("the repair mirror reproduces the reducer's tool-boundary paragraph break", async () => {
		const { wiring, ws } = await makeWiring();
		wiring.wrappedOnEvent({ type: "stream", delta: "Step one." });
		wiring.wrappedOnEvent({ type: "tool_start", toolName: "bash", toolCallId: "t1", args: {} });
		wiring.wrappedOnEvent({ type: "tool_end", toolName: "bash", toolCallId: "t1", result: "ok", allowed: true });
		wiring.wrappedOnEvent({ type: "stream", delta: "Step two.<think>hmm" });
		wiring.wrappedOnEvent(DONE);
		// The client holds "Step one.\n\nStep two.<think>hmm" (its reducer
		// inserted the break) — the repair must keep that break, not the raw
		// server-side concatenation.
		const replace = ws.find((e) => e.type === "stream" && "replace" in e) as { text: string };
		expect(replace.text).toBe("Step one.\n\nStep two.");
	});

	it("the repair mirror reproduces the reducer's error append so the error line survives", async () => {
		const { wiring, ws } = await makeWiring();
		wiring.wrappedOnEvent({ type: "stream", delta: "Hi<|im_en" });
		wiring.wrappedOnEvent({ type: "stream", delta: "d|>." });
		const err: ServerEvent = { type: "error", message: "boom" };
		wiring.wrappedOnEvent(err);
		wiring.wrappedOnEvent(DONE);
		expect(ws[2]).toBe(err); // error itself passes through by reference
		const replace = ws.find((e) => e.type === "stream" && "replace" in e) as { text: string };
		expect(replace.text).toBe("Hi.\n\nError: boom");
	});
});

describe("wrappedOnEvent — pass-through for everything else (blast-radius)", () => {
	it("forwards every non-answer-text event type by reference, in order", async () => {
		const { wiring, ws } = await makeWiring();
		const events: ServerEvent[] = [
			{ type: "chat_op_started", opId: "op-1" } as unknown as ServerEvent,
			{ type: "reasoning", delta: "thinking…" },
			{ type: "reasoning", replace: true, text: "coalesced thinking" },
			{ type: "tool_start", toolName: "bash", args: { cmd: "ls" }, riskLevel: "low" },
			{ type: "tool_progress", toolName: "bash", message: "running" },
			{ type: "tool_end", toolName: "bash", result: "<|im_end|> looks like junk but is tool output", allowed: true },
			{ type: "approval_requested", approvalId: "a1", toolName: "bash", context: "c", argsPreview: "p" },
			{ type: "approval_resolved", approvalId: "a1", toolName: "bash", approved: true },
			{ type: "stopped", reason: "Paused." },
			{ type: "context_status", percentage: 10, level: "ok", usedTokens: 1, maxTokens: 10, compacted: false },
			{ type: "op_heartbeat" } as unknown as ServerEvent,
		];
		for (const ev of events) wiring.wrappedOnEvent(ev);
		expect(ws).toHaveLength(events.length);
		events.forEach((ev, i) => expect(ws[i]).toBe(ev));
	});
});

describe("wrappedOnEvent — canary sibling behavior is preserved", () => {
	it("a canary trip still suppresses the delta and aborts the turn", async () => {
		const { wiring, ws, sse, abortController } = await makeWiring();
		checkOutputMock.mockReturnValueOnce({ tripped: true });
		wiring.wrappedOnEvent({ type: "stream", delta: "exfil attempt" });
		expect(ws).toHaveLength(0); // never forwarded
		expect(sse).toHaveLength(1);
		expect(sse[0]).toMatchObject({ type: "error", message: expect.stringContaining("prompt injection") });
		expect(abortController.signal.aborted).toBe(true);
	});
});

describe("primaryEventProxy — composes with the hygiene wrapper", () => {
	it("swallows done (fallback decision pending) but strips deltas it forwards", async () => {
		const { wiring, ws } = await makeWiring();
		wiring.primaryEventProxy(DONE);
		expect(ws).toHaveLength(0);
		wiring.primaryEventProxy({ type: "stream", delta: "Done.<|eot_id|>" });
		expect(ws[0]).toEqual({ type: "stream", delta: "Done." });
	});
});
