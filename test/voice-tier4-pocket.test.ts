// Pocket TTS tier-4 variant: over-generation guard + factory registration.
// The engine's live subprocess path is smoke-tested by the orchestrator, not
// here — these are the pure/registration seams.
import { describe, it, expect } from "vitest";
import { guardPocketAudio, expectedMaxDurationSec } from "../src/voice/tier4/pocket-guard.js";

const SR = 24000;
function tone(seconds: number, amp = 0.3): Float32Array {
	const a = new Float32Array(Math.floor(seconds * SR));
	for (let i = 0; i < a.length; i++) a[i] = amp * Math.sin(i * 0.05);
	return a;
}

describe("pocket over-generation guard", () => {
	it("leaves normal-length audio untouched", () => {
		// "Sure, that's done." ~1s of real speech; a ~1.5s render is well within cap.
		const audio = tone(1.5);
		const out = guardPocketAudio("Sure, that's done.", audio, SR);
		expect(out.length).toBe(audio.length);
	});

	it("trims clear over-generation on a short input", () => {
		// Same 18-char text but the engine padded it to 6s (the bench failure).
		const text = "Sure, that's done.";
		const audio = tone(6.0);
		let fired = false;
		const out = guardPocketAudio(text, audio, SR, () => { fired = true; });
		expect(fired).toBe(true);
		expect(out.length).toBeLessThan(audio.length);
		expect(out.length / SR).toBeLessThanOrEqual(expectedMaxDurationSec(text) + 0.05);
	});

	it("does not trim a long sentence that legitimately takes many seconds", () => {
		const text = "Every time the schedule changes I have to re-check the whole calendar again, which already moved twice this week and is getting exhausting to keep straight.";
		const audio = tone(9.0); // long text → high cap → no trim
		const out = guardPocketAudio(text, audio, SR);
		expect(out.length).toBe(audio.length);
	});

	it("expected cap scales with text length and never below the floor", () => {
		expect(expectedMaxDurationSec("")).toBeGreaterThan(0);
		expect(expectedMaxDurationSec("a very long sentence here"))
			.toBeGreaterThan(expectedMaxDurationSec("hi"));
	});

	it("handles empty/degenerate audio without throwing", () => {
		expect(guardPocketAudio("x", new Float32Array(0), SR).length).toBe(0);
		expect(guardPocketAudio("x", tone(1), 0).length).toBe(tone(1).length);
	});
});

describe("pocket factory registration", () => {
	it("registers 'pocket' alongside kokoro/kitten without displacing them", async () => {
		await import("../src/voice/tier4/tier4-factory.js");
		const { listTtsProviders } = await import("../src/voice/tier4/registry.js");
		const names = listTtsProviders().map((p) => p.name);
		expect(names).toContain("pocket");
		expect(names).toContain("kokoro");
		expect(names).toContain("kitten");
	});
});
