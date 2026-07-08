import { describe, it, expect, beforeEach } from "vitest";

import { recordSessionBaselineObservation, getSessionBaselineTokens, resetSessionBaselines } from "./session-baseline.js";
import type { ProviderStateEnvelope } from "./types.js";
import type { CanonicalMessage } from "./contract-types.js";

beforeEach(() => resetSessionBaselines());

// A user message of N*3.5 chars estimates to 4 (overhead) + N tokens.
function userMsg(tokens: number): CanonicalMessage {
	return { messageId: "m", role: "user", content: { text: "x".repeat((tokens - 4) * 3.5) } };
}

function ps(payload: Record<string, unknown>, opts: { adapterName?: string; viewCompacted?: boolean } = {}): ProviderStateEnvelope {
	return {
		adapterName: opts.adapterName ?? "anthropic",
		adapterVersion: "1",
		providerPayload: { model: "claude-sonnet-4-6", ...payload },
		...(opts.viewCompacted !== undefined ? { viewCompacted: opts.viewCompacted } : {}),
	};
}

// prefix = input + cacheRead + cacheCreate = 2 + 70000 + 47000 = 117002
const cleanPayload = { usageInputTokens: 2, usageOutputTokens: 5, cacheReadTokens: 70_000, cacheCreateTokens: 47_000 };

describe("session baseline — observe at commit, read O(1)", () => {
	it("returns null before any observation", () => {
		expect(getSessionBaselineTokens("sess_none")).toBeNull();
	});

	it("isolates baseline = real prefix − estimated prompt conversation", () => {
		// prompt conversation ≈ 1000 tokens → baseline ≈ 117002 − 1004
		recordSessionBaselineObservation("sess_a", "chat_turn", ps(cleanPayload, { viewCompacted: false }), [], [userMsg(1004)]);
		expect(getSessionBaselineTokens("sess_a")).toBe(117_002 - 1004);
	});

	it("does NOT record a tool-bearing turn (cumulative usage is unreliable)", () => {
		recordSessionBaselineObservation("sess_tool", "chat_turn", ps(cleanPayload, { viewCompacted: false }), ["mcp__lax__glob"], [userMsg(1004)]);
		expect(getSessionBaselineTokens("sess_tool")).toBeNull();
	});

	it("does NOT record a compacted-view turn", () => {
		recordSessionBaselineObservation("sess_comp", "chat_turn", ps(cleanPayload, { viewCompacted: true }), [], [userMsg(1004)]);
		expect(getSessionBaselineTokens("sess_comp")).toBeNull();
	});

	it("does NOT record a non-anthropic turn", () => {
		recordSessionBaselineObservation("sess_oai", "chat_turn", ps(cleanPayload, { adapterName: "openai-compat", viewCompacted: false }), [], [userMsg(1004)]);
		expect(getSessionBaselineTokens("sess_oai")).toBeNull();
	});

	it("does NOT record an implausible prefix above the window", () => {
		recordSessionBaselineObservation("sess_over", "chat_turn", ps({ ...cleanPayload, cacheReadTokens: 300_000 }, { viewCompacted: false }), [], [userMsg(1004)]);
		expect(getSessionBaselineTokens("sess_over")).toBeNull();
	});

	it("does NOT record when cache fields are missing (absent ≠ 0)", () => {
		recordSessionBaselineObservation("sess_nc", "chat_turn", ps({ usageInputTokens: 5000, usageOutputTokens: 100 }, { viewCompacted: false }), [], [userMsg(1004)]);
		expect(getSessionBaselineTokens("sess_nc")).toBeNull();
	});

	// The baseline is conversation-INDEPENDENT, so the tightest (smallest-conv)
	// observation is the most accurate. A later big-conversation turn must NOT
	// overwrite a small-conversation one.
	it("keeps the observation from the smallest-conversation turn", () => {
		recordSessionBaselineObservation("sess_min", "chat_turn", ps(cleanPayload, { viewCompacted: false }), [], [userMsg(1004)]);   // conv 1004
		const small = getSessionBaselineTokens("sess_min");
		recordSessionBaselineObservation("sess_min", "chat_turn", ps(cleanPayload, { viewCompacted: false }), [], [userMsg(50_004)]); // conv 50004 — bigger, ignored
		expect(getSessionBaselineTokens("sess_min")).toBe(small);
		expect(small).toBe(117_002 - 1004);
	});

	it("adopts a smaller-conversation observation that arrives later", () => {
		recordSessionBaselineObservation("sess_adopt", "chat_turn", ps(cleanPayload, { viewCompacted: false }), [], [userMsg(50_004)]); // big first
		recordSessionBaselineObservation("sess_adopt", "chat_turn", ps(cleanPayload, { viewCompacted: false }), [], [userMsg(1004)]);   // smaller later
		expect(getSessionBaselineTokens("sess_adopt")).toBe(117_002 - 1004);
	});

	it("ignores an empty sessionId", () => {
		recordSessionBaselineObservation("", "chat_turn", ps(cleanPayload, { viewCompacted: false }), [], [userMsg(1004)]);
		expect(getSessionBaselineTokens("")).toBeNull();
	});

	it("keeps sessions isolated", () => {
		recordSessionBaselineObservation("sess_x", "chat_turn", ps(cleanPayload, { viewCompacted: false }), [], [userMsg(1004)]);
		expect(getSessionBaselineTokens("sess_y")).toBeNull();
	});

	// Cross-op-type contamination guard: a delegated/submitted op inherits the
	// parent chat sessionId but has a DIFFERENT (narrower) tool surface. Letting
	// it observe would let min-conv-wins clobber the chat baseline DOWNWARD →
	// under-count → the death this exists to prevent. Only "chat_turn" observes.
	it("ignores a non-chat op sharing the session (no cross-op-type clobber)", () => {
		recordSessionBaselineObservation("sess_shared", "chat_turn", ps(cleanPayload, { viewCompacted: false }), [], [userMsg(1004)]);
		const chatBaseline = getSessionBaselineTokens("sess_shared");
		// A delegated op: same session, smaller conversation, smaller (narrower-tooled) prefix.
		recordSessionBaselineObservation("sess_shared", "research", ps({ ...cleanPayload, cacheReadTokens: 10_000, cacheCreateTokens: 0 }, { viewCompacted: false }), [], [userMsg(4)]);
		expect(getSessionBaselineTokens("sess_shared")).toBe(chatBaseline); // unchanged, not clobbered to ~10k
		expect(chatBaseline).toBe(117_002 - 1004);
	});
});
