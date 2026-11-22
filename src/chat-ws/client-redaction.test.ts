import { afterEach, describe, expect, it } from "vitest";
import type { WebSocket } from "ws";
import type { ServerResponse } from "node:http";
import type { ServerEvent } from "../types.js";
import { clients } from "./state.js";
import { broadcastAll, broadcastToSession } from "./broadcast.js";
import { sendFrame } from "./frames.js";
import { sendProcessRelayDelivery } from "./process-relay-delivery.js";
import { sseWrite } from "../server-utils.js";
import { redactEventCredentials } from "../security/index.js";

// One credential, and every chat transport that carries an event to a client.
// The SSE path masked tool results and stream deltas while the chat socket
// (and the phone relay riding it) masked nothing; this pins them together.
const KEY = "ghp_" + "a".repeat(40);
const SESSION = "s-redaction";

function socket() {
	const sent: string[] = [];
	const ws = { readyState: 1, bufferedAmount: 0, send: (p: string) => sent.push(p) } as unknown as WebSocket;
	return { ws, sent };
}
afterEach(() => clients.clear());

const carriers: ServerEvent[] = [
	{ type: "tool_end", toolName: "bash", result: `token=${KEY}`, allowed: true },
	{ type: "tool_start", toolName: "http_request", args: { headers: { Authorization: `Bearer ${KEY}` }, n: 1 } },
	{ type: "tool_progress", toolName: "bash", message: `using ${KEY}` },
	{ type: "stream", delta: `here: ${KEY}` },
	{ type: "stream", replace: true, text: `here: ${KEY}` },
	{ type: "reasoning", delta: `the key is ${KEY}` },
	{ type: "error", message: `provider refused: Authorization: Bearer ${KEY}` },
];

describe("credentials never reach a chat client", () => {
	it.each(carriers.map((e) => [e.type, e] as const))("redactEventCredentials masks %s", (_t, event) => {
		const out = JSON.stringify(redactEventCredentials(event));
		expect(out).not.toContain(KEY);
	});

	it("keeps tool args' shape while masking their strings", () => {
		const out = redactEventCredentials(carriers[1]) as Extract<ServerEvent, { type: "tool_start" }>;
		expect(out.args).toMatchObject({ headers: { Authorization: expect.any(String) }, n: 1 });
	});

	it("SSE, socket broadcast, broadcastAll, sendFrame and the worker relay all mask the same result", () => {
		const event = carriers[0];
		const written: string[] = [];
		sseWrite({ write: (s: string) => written.push(s) } as unknown as ServerResponse, event);

		const a = socket();
		clients.set(a.ws, new Set([SESSION]));
		broadcastToSession(SESSION, event);
		broadcastAll({ type: "event", sessionId: SESSION, event });
		sendFrame(a.ws, { type: "event", sessionId: SESSION, event });
		sendProcessRelayDelivery({
			type: "process_relay_delivery", deliveryId: "d1", sessionId: SESSION, scope: "session", ackRequired: false,
			events: [event], eventIds: ["e1"],
		} as unknown as Parameters<typeof sendProcessRelayDelivery>[0]);

		const all = [...written, ...a.sent];
		expect(a.sent).toHaveLength(4);
		for (const payload of all) {
			expect(payload).not.toContain(KEY);
			expect(payload).toContain("token=");
		}
	});

	it("a reconnect replay's frames are masked like live ones, with their op fields kept", () => {
		// reconnect-op.ts used to write these with JSON.stringify of its own: the
		// error it rebuilt from the op's log went out as stored.
		const a = socket();
		sendFrame(a.ws, { type: "event", sessionId: SESSION, event: carriers.at(-1)!, _opId: "op_1", _seq: 7 });
		sendFrame(a.ws, { type: "event", sessionId: SESSION, event: carriers[4], _opId: "op_1", _replay: true });
		for (const payload of a.sent) expect(payload).not.toContain(KEY);
		expect(JSON.parse(a.sent[0])).toMatchObject({ _opId: "op_1", _seq: 7, event: { type: "error" } });
		expect(JSON.parse(a.sent[1])).toMatchObject({ _opId: "op_1", _replay: true, event: { replace: true } });
	});
});

describe("a worker relay's batch reaches the tabs its events are for", () => {
	const batch = (sessionId: string, scope: "session" | "mixed" | "global", events: ServerEvent[]) => ({
		type: "process_relay_delivery", opId: "op_1", generationId: "g1", cursor: 1, deliveryId: "d1",
		sessionId, scope, events, eventIds: events.map((_e, i) => `d1:${i}`),
	}) as Parameters<typeof sendProcessRelayDelivery>[0];
	const text: ServerEvent = { type: "stream", delta: "working" };
	const queued = { type: "bg_op_queued", opId: "op_1" } as unknown as ServerEvent;

	it("a session batch goes to the session's tabs only; a mixed one gives the rest its global events", () => {
		const viewer = socket();
		const other = socket();
		clients.set(viewer.ws, new Set([SESSION]));
		clients.set(other.ws, new Set(["s-other"]));

		expect(sendProcessRelayDelivery(batch(SESSION, "session", [text]))).toBe(1);
		expect(other.sent).toEqual([]);

		expect(sendProcessRelayDelivery(batch(SESSION, "mixed", [text, queued]))).toBe(2);
		expect(JSON.parse(viewer.sent[1]).events).toHaveLength(2);
		expect(JSON.parse(other.sent[0])).toMatchObject({ scope: "global", ackRequired: false, events: [{ type: "bg_op_queued" }], eventIds: ["d1:1"] });
	});

	it("a headless session's own events reach no tab, even one subscribed to it", () => {
		// broadcastToSession refuses these sessions; the relay's own loop did not.
		const headless = "skill-review-abc";
		const tab = socket();
		clients.set(tab.ws, new Set([headless]));

		expect(sendProcessRelayDelivery(batch(headless, "session", [text]))).toBe(0);
		expect(sendProcessRelayDelivery(batch(headless, "mixed", [text, queued]))).toBe(1);
		expect(tab.sent).toHaveLength(1);
		expect(JSON.parse(tab.sent[0])).toMatchObject({ scope: "global", events: [{ type: "bg_op_queued" }] });
	});
});
