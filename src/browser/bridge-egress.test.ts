import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { answerEgressAsk, enrichBlockedNavigation, recentEgressDeny } from "./bridge-egress.js";

// A policy deny used to reach the agent as the bare Chromium symptom —
// "ERR_BLOCKED_BY_CLIENT (http://localhost:3000/)" — with the reason and
// recovery visible only in the server log. answerEgressAsk now records each
// deny; enrichBlockedNavigation rewraps the navigate failure with it.

describe("browser egress deny — reason surfaced to the agent", () => {
	const ORIG_PORT = process.env.LAX_PORT;
	let sent: unknown[];

	beforeEach(() => {
		process.env.LAX_PORT = "7007";
		sent = [];
		process.send = ((msg: unknown) => { sent.push(msg); return true; }) as typeof process.send;
	});

	afterEach(() => {
		if (ORIG_PORT === undefined) delete process.env.LAX_PORT;
		else process.env.LAX_PORT = ORIG_PORT;
		delete (process as { send?: unknown }).send;
		vi.restoreAllMocks();
	});

	it("denies a non-registered loopback port and records the reason", () => {
		answerEgressAsk({ id: 1, url: "http://localhost:3000/" });
		expect(sent).toEqual([{ type: "lax:browser-egress-ask-result", id: 1, allowed: false }]);
		const deny = recentEgressDeny("http://localhost:3000/");
		expect(deny?.reason).toMatch(/blocked/i);
	});

	it("rewraps ERR_BLOCKED_BY_CLIENT with the recorded policy reason", () => {
		answerEgressAsk({ id: 2, url: "http://localhost:3000/" });
		const raw = new Error("browser navigate failed (viewId=v1): ERR_BLOCKED_BY_CLIENT (http://localhost:3000/)");
		const enriched = enrichBlockedNavigation(raw, "http://localhost:3000/") as Error;
		expect(enriched.message).toContain("blocked by the egress policy");
		expect(enriched.message).not.toBe(raw.message);
	});

	it("correlates across a trailing slash and a query token added en route", () => {
		answerEgressAsk({ id: 3, url: "http://localhost:3000/?lax_token=abc" });
		const deny = recentEgressDeny("http://localhost:3000");
		expect(deny).not.toBeNull();
	});

	it("passes non-blocked failures through untouched", () => {
		const raw = new Error("browser navigate failed (viewId=v1): ERR_NAME_NOT_RESOLVED (http://nope.example/)");
		expect(enrichBlockedNavigation(raw, "http://nope.example/")).toBe(raw);
	});

	it("passes ERR_BLOCKED_BY_CLIENT through when no deny was recorded (ad-blocker-style block)", () => {
		const raw = new Error("browser navigate failed (viewId=v1): ERR_BLOCKED_BY_CLIENT (http://unrelated.example/)");
		expect(enrichBlockedNavigation(raw, "http://unrelated.example/")).toBe(raw);
	});
});
