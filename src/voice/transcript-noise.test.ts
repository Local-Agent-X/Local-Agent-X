// Whisper noise-annotation scrubber — the "(muffled speaking" regression.
// A stage direction Whisper hallucinated on cut-off audio reached the agent
// as user speech and got a "didn't catch that" reply as its own turn.
import { describe, expect, it } from "vitest";
import { collapseLoopedRepeats, stripTranscriptNoise } from "./transcript-noise.js";

describe("stripTranscriptNoise", () => {
	it("drops whole-final parenthesized stage directions, closed or unclosed", () => {
		expect(stripTranscriptNoise("(muffled speaking")).toBe("");
		expect(stripTranscriptNoise("(muffled speaking)")).toBe("");
		expect(stripTranscriptNoise("(inaudible)")).toBe("");
		expect(stripTranscriptNoise("  (speaking indistinctly)  ")).toBe("");
	});

	it("drops whole-final asterisk directions", () => {
		expect(stripTranscriptNoise("*sighs*")).toBe("");
		expect(stripTranscriptNoise("*coughing")).toBe("");
	});

	it("strips bracketed annotations anywhere, including unclosed tails", () => {
		expect(stripTranscriptNoise("[BLANK_AUDIO]")).toBe("");
		expect(stripTranscriptNoise("hello [music] there")).toBe("hello  there");
		expect(stripTranscriptNoise("so anyway [BLANK_AU")).toBe("so anyway");
	});

	it("keeps real speech intact, including mid-sentence parentheticals", () => {
		expect(stripTranscriptNoise("call John (my brother) tomorrow")).toBe("call John (my brother) tomorrow");
		expect(stripTranscriptNoise("I can't keep living this way")).toBe("I can't keep living this way");
	});

	it("returns empty for blank input", () => {
		expect(stripTranscriptNoise("")).toBe("");
		expect(stripTranscriptNoise("   ")).toBe("");
	});
});

describe("collapseLoopedRepeats — Whisper's decoder looping on a live utterance", () => {
	it("keeps one of a sentence looped three times (phone call 2026-11-05)", () => {
		const looped = "Well, we can practice more in a few questions. Well, we can practice more in a few questions. Well, we can practice more in a few questions.";
		expect(collapseLoopedRepeats(looped)).toBe("Well, we can practice more in a few questions.");
	});

	it("drops a repeated sentence of four words or more after the first, keeping what follows", () => {
		expect(collapseLoopedRepeats("Set a reminder for three. Set a reminder for three. Thanks."))
			.toBe("Set a reminder for three. Thanks.");
	});

	it("keeps short repeats people do say, up to twice", () => {
		expect(collapseLoopedRepeats("No. No. I said Tuesday.")).toBe("No. No. I said Tuesday.");
		expect(collapseLoopedRepeats("Okay. Okay. Okay. Go.")).toBe("Okay. Okay. Go.");
		expect(collapseLoopedRepeats("it was very very good")).toBe("it was very very good");
	});

	it("collapses a phrase looped three times or more with no punctuation between", () => {
		expect(collapseLoopedRepeats("and then I said you know what I mean you know what I mean you know what I mean right"))
			.toBe("and then I said you know what I mean right");
	});

	it("leaves ordinary speech, and a phrase said twice, untouched", () => {
		const text = "When using Claude Code, is it best to use hooks to make the model do something?";
		expect(collapseLoopedRepeats(text)).toBe(text);
		expect(collapseLoopedRepeats("I don't know, I don't know what to do")).toBe("I don't know, I don't know what to do");
	});

	it("treats sentences in other scripts the same way", () => {
		expect(collapseLoopedRepeats("你好，我们今天去哪里吃饭。你好，我们今天去哪里吃饭。")).toBe("你好，我们今天去哪里吃饭。");
	});
});
