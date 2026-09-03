/**
 * toSpokenCompletion — what a finished background op SOUNDS like.
 *
 * The regression that earned this file: a verification op's final text is the
 * brief's mandated per-value table, and the generic path read the op's final
 * text aloud verbatim. TTS therefore recited the table row by row INCLUDING
 * the markdown separator — "dash dash dash dash" — for what should have been
 * a one-line verdict. verify_deliverable completions now get a HEADLINE; the
 * table stays on the text surfaces.
 *
 * Pinned here: the spoken string for each of the three verdicts the brief's
 * output contract allows, that no markdown survives into any of them, and
 * that ordinary (non-verification) ops are untouched by the branch.
 */
import { describe, it, expect } from "vitest";
import { toSpokenCompletion } from "./session-bridge-extractors.js";
import { VERIFICATION_OP_TYPE } from "./verification-spend.js";

/** A verdict shaped like the brief asks for it, markdown table and all —
 *  including the separator row that used to be read out loud. */
function verdictText(verdict: string, rows: string[]): string {
	return [
		`VERDICT: ${verdict}`,
		"| value | deliverable says | independent source says | match? |",
		"| --- | --- | --- | --- |",
		...rows,
	].join("\n");
}

const THREE_ROWS = [
	"| Infineon share | 41% | 37% | no |",
	"| Navitas share | 18% | 18% | yes |",
	"| Total 2026 units | 4.1M | 3.9M | no |",
];

describe("toSpokenCompletion — verification verdicts are spoken as a headline", () => {
	it("DISCREPANCIES: names the verdict and how many values moved", () => {
		const spoken = toSpokenCompletion("Verification pass: build the sheet", verdictText("DISCREPANCIES", THREE_ROWS), "completed", VERIFICATION_OP_TYPE);
		expect(spoken).toBe("Verification finished: discrepancies on 2 of 3 checked values.");
	});

	it("CONFIRMED: names the verdict and the count that matched", () => {
		const rows = ["| Infineon share | 41% | 41% | yes |", "| Navitas share | 18% | 18% | yes |"];
		const spoken = toSpokenCompletion("Verification pass: build the sheet", verdictText("CONFIRMED", rows), "completed", VERIFICATION_OP_TYPE);
		expect(spoken).toBe("Verification finished: confirmed. All 2 checked values matched.");
	});

	it("UNVERIFIABLE: says why, with no count to give", () => {
		const spoken = toSpokenCompletion("Verification pass: build the sheet", "VERDICT: UNVERIFIABLE\nno independent source published these figures", "completed", VERIFICATION_OP_TYPE);
		expect(spoken).toBe("Verification finished: unverifiable. Independent figures could not be obtained.");
	});

	it("a single checked value is spoken in the singular", () => {
		const spoken = toSpokenCompletion("t", verdictText("CONFIRMED", ["| Infineon share | 41% | 41% | yes |"]), "completed", VERIFICATION_OP_TYPE);
		expect(spoken).toBe("Verification finished: confirmed. All 1 checked value matched.");
	});

	it("never lets table syntax reach the speaker — the separator row above all", () => {
		for (const verdict of ["CONFIRMED", "DISCREPANCIES", "UNVERIFIABLE"]) {
			const spoken = toSpokenCompletion("t", verdictText(verdict, THREE_ROWS), "completed", VERIFICATION_OP_TYPE);
			expect(spoken).not.toContain("|");
			expect(spoken).not.toContain("---");
			expect(spoken).not.toContain("match?");
			expect(spoken.split("\n")).toHaveLength(1);
		}
	});

	it("degrades to a bare headline when the verdict word is missing or unknown", () => {
		expect(toSpokenCompletion("t", "the model wandered off contract", "completed", VERIFICATION_OP_TYPE))
			.toBe("Verification finished. The verdict is in the chat.");
		expect(toSpokenCompletion("t", "VERDICT: MAYBE\n| a | b | c | d |", "completed", VERIFICATION_OP_TYPE))
			.toBe("Verification finished. The verdict is in the chat.");
	});

	it("DISCREPANCIES with no row marked `no` still speaks, without inventing a count", () => {
		const spoken = toSpokenCompletion("t", verdictText("DISCREPANCIES", ["| Infineon share | 41% | 41% | yes |"]), "completed", VERIFICATION_OP_TYPE);
		expect(spoken).toBe("Verification finished: discrepancies found. The details are in the chat.");
	});
});

describe("toSpokenCompletion — every other op is unaffected", () => {
	it("an ordinary completion keeps the generic lead and its summary", () => {
		expect(toSpokenCompletion("build the app", "App built and running.", "completed"))
			.toBe("Quick update — that background task finished: App built and running.");
	});

	it("a failure keeps the trouble lead, verification op or not", () => {
		expect(toSpokenCompletion("t", "provider 500", "failed"))
			.toBe("Heads up — that background task ran into trouble: provider 500");
		// A failed verification is quieted upstream and never reaches the
		// speaker; if it ever does, it must not be dressed up as a verdict.
		expect(toSpokenCompletion("t", verdictText("CONFIRMED", THREE_ROWS), "failed", VERIFICATION_OP_TYPE))
			.toContain("ran into trouble");
	});

	it("an op whose type merely resembles the verifier's is not treated as one", () => {
		expect(toSpokenCompletion("t", verdictText("CONFIRMED", THREE_ROWS), "completed", "verify_deliverable_v2"))
			.toContain("that background task finished");
	});
});
