// The spoken voice turn must run on the provider's FAST tier, not the chat
// model. Regression: voice inherited gpt-5.6-sol (a reasoning model) and spent
// 13-16s thinking before the first spoken token.
import { describe, it, expect } from "vitest";
import { resolveVoiceModel } from "./voice-model.js";

// getSetting stub factory — returns the given voiceModel value (or undefined).
function settings(voiceModel?: string) {
	return <T,>(key: string): T | undefined =>
		(key === "voiceModel" ? (voiceModel as unknown as T) : undefined);
}

describe("resolveVoiceModel", () => {
	it("routes each provider to its OWN declared fast tier by default", () => {
		const none = settings(undefined);
		expect(resolveVoiceModel("codex", "gpt-5.6-sol", none)).toBe("gpt-5.4-mini");
		expect(resolveVoiceModel("openai", "gpt-5.6", none)).toBe("gpt-4o-mini");
		expect(resolveVoiceModel("gemini", "gemini-2.5-pro", none)).toBe("gemini-2.0-flash");
		expect(resolveVoiceModel("anthropic", "claude-opus-5", none)).toBe("claude-haiku-4-5");
	});

	it("does not pin voice to one provider — the provider is kept, only the model swaps", () => {
		// The chat provider is whatever the user selected; the fast model is
		// that provider's tier, never a fixed cross-provider default.
		expect(resolveVoiceModel("xai", "grok-4.5", settings(undefined))).not.toBe("gpt-5.4-mini");
	});

	it("an explicit voiceModel setting pins that exact model", () => {
		expect(resolveVoiceModel("codex", "gpt-5.6-sol", settings("gpt-5.4-mini"))).toBe("gpt-5.4-mini");
		expect(resolveVoiceModel("anthropic", "claude-opus-5", settings("claude-sonnet-5"))).toBe("claude-sonnet-5");
	});

	it("voiceModel = 'chat'/'same' opts out — keeps the (slow) chat model", () => {
		expect(resolveVoiceModel("codex", "gpt-5.6-sol", settings("chat"))).toBe("gpt-5.6-sol");
		expect(resolveVoiceModel("codex", "gpt-5.6-sol", settings("same"))).toBe("gpt-5.6-sol");
	});

	it("a provider with no declared fast tier falls through to the chat model", () => {
		// local / ollama-cloud have a dynamic catalog and no static backgroundModel.
		expect(resolveVoiceModel("local", "llama3.1:8b", settings(undefined))).toBe("llama3.1:8b");
	});

	it("unreadable settings never throw — falls back to the fast tier", () => {
		const boom = <T,>(_key: string): T | undefined => { throw new Error("settings gone"); };
		expect(resolveVoiceModel("codex", "gpt-5.6-sol", boom)).toBe("gpt-5.4-mini");
	});
});
