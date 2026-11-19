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
});
