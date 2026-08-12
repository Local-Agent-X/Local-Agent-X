// Near-field gate: reject far-field background talkers the VAD can't.
import { describe, it, expect } from "vitest";
import { createNearFieldGate, utteranceLoudness, frameRms } from "../src/voice/voice-session/near-field-gate.js";

// Int16 sine at a given normalized amplitude (0..1) → RMS ≈ amp/√2.
function tone(seconds: number, amp: number): Int16Array {
	const n = Math.floor(seconds * 16000);
	const a = new Int16Array(n);
	for (let i = 0; i < n; i++) a[i] = Math.round(amp * 32767 * Math.sin(i * 0.06));
	return a;
}

describe("near-field loudness", () => {
	it("measures louder audio as louder", () => {
		expect(utteranceLoudness(tone(0.5, 0.3))).toBeGreaterThan(utteranceLoudness(tone(0.5, 0.03)));
	});
	it("high-percentile ignores leading/trailing silence padding", () => {
		// A loud word buried in silence still reads as loud (near-field), not diluted.
		const buf = new Int16Array(16000); // 1s silence
		buf.set(tone(0.3, 0.3), 4000);     // 300ms loud word in the middle
		expect(utteranceLoudness(buf)).toBeGreaterThan(0.1);
	});
});

describe("near-field gate", () => {
	it("rejects near-silence outright, before any user baseline", () => {
		const g = createNearFieldGate();
		expect(g.accept(tone(0.5, 0.004)).pass).toBe(false); // room hum
		expect(g.userLevel).toBe(0); // nothing accepted → no baseline drift
	});

	it("accepts the user, then rejects far-field background quieter than them", () => {
		const g = createNearFieldGate();
		// User speaks up close a few times → establishes the baseline.
		for (let i = 0; i < 3; i++) expect(g.accept(tone(0.6, 0.25)).pass).toBe(true);
		// A colleague across the room, ~5x quieter → rejected.
		const bg = g.accept(tone(0.6, 0.05));
		expect(bg.pass).toBe(false);
		expect(bg.loudness).toBeLessThan(bg.floor);
		// The user, still close, keeps passing.
		expect(g.accept(tone(0.6, 0.25)).pass).toBe(true);
	});

	it("adapts to a soft-spoken user in a quiet room (relative, not fixed)", () => {
		const g = createNearFieldGate();
		// Soft but consistent user (above the absolute floor).
		for (let i = 0; i < 4; i++) g.accept(tone(0.6, 0.05));
		expect(g.accept(tone(0.6, 0.05)).pass).toBe(true);   // their own voice passes
		expect(g.accept(tone(0.6, 0.008)).pass).toBe(false); // quiet background still rejected
	});

	it("isNearFieldFrame gates barge-in frames against the current floor", () => {
		const g = createNearFieldGate();
		for (let i = 0; i < 3; i++) g.accept(tone(0.6, 0.25));
		expect(g.isNearFieldFrame(tone(0.02, 0.25))).toBe(true);   // user cutting in
		expect(g.isNearFieldFrame(tone(0.02, 0.03))).toBe(false);  // background murmur
	});

	it("frameRms handles empty input", () => {
		expect(frameRms(new Int16Array(0))).toBe(0);
	});
});
