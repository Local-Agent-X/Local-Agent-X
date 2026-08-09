// Whisper noise-annotation scrubber — the "(muffled speaking" regression.
// A stage direction Whisper hallucinated on cut-off audio reached the agent
// as user speech and got a "didn't catch that" reply as its own turn.
import { describe, expect, it } from "vitest";
import { stripTranscriptNoise } from "./transcript-noise.js";

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
