// The one seam where plaintext touches a live page. These pin the properties
// that keep it from escaping: the verdict is computed in the page (so the value
// never makes the return trip), unknown shapes fail closed, and the scripts both
// backends run are the same text.
import { describe, it, expect } from "vitest";
import {
	asElementDescriptor,
	asFillOutcome,
	describeElementScript,
	fillSecretScript,
	readValueScript,
	type SecretFillOutcome,
} from "./secret-ops.js";

const SECRET = "super-secret-token-zzzZZZ-1234567890";

describe("fillSecretScript", () => {
	it("decides the verdict in the page, returning no value", () => {
		const script = fillSecretScript("#pw", SECRET);
		// Every return path yields a bare { kind: ... } — there is no branch that
		// hands the value (or the field's actual content) back across the bridge.
		const returns = script.match(/return \{[^}]*\}/g) ?? [];
		expect(returns.length).toBeGreaterThan(0);
		for (const r of returns) {
			expect(r).toMatch(/^return \{ kind: "[a-z-]+" \}$/);
		}
	});

	it("compares in-page rather than shipping the value back to compare", () => {
		const script = fillSecretScript("#pw", SECRET);
		expect(script).toContain(`el.value === ${JSON.stringify(SECRET)}`);
		expect(script).not.toMatch(/return .*el\.value/);
	});

	it("embeds the value as a JSON literal, never as raw source", () => {
		// A quote or backslash in a password would otherwise break out of the
		// string and run as script.
		const nasty = `"; alert(1); var x="`;
		const script = fillSecretScript("#pw", nasty);
		expect(script).toContain(JSON.stringify(nasty));
		expect(JSON.parse(JSON.stringify(nasty))).toBe(nasty);
	});

	it("focuses the field so a following real Enter lands on it", () => {
		expect(fillSecretScript("#pw", SECRET)).toContain("el.focus()");
	});
});

describe("asFillOutcome", () => {
	it("accepts every known verdict", () => {
		const kinds: SecretFillOutcome["kind"][] = [
			"landed", "masked-unverifiable", "mismatch", "not-found", "not-fillable",
		];
		for (const kind of kinds) expect(asFillOutcome({ kind })).toEqual({ kind });
	});

	it("fails closed on anything a hostile or broken page could return", () => {
		// Fail-closed direction is "mismatch": the caller reports the fill did not
		// land rather than claiming a success it cannot back up.
		for (const raw of [null, undefined, {}, { kind: "landed!" }, { kind: 1 }, "landed", []]) {
			expect(asFillOutcome(raw)).toEqual({ kind: "mismatch" });
		}
	});

	it("never carries a value through, even when the page adds one", () => {
		expect(asFillOutcome({ kind: "landed", value: SECRET, actual: SECRET })).toEqual({ kind: "landed" });
	});
});

describe("asElementDescriptor", () => {
	it("coerces a page-supplied shape to the descriptor the guardrails read", () => {
		expect(asElementDescriptor({ found: true, tag: "INPUT", type: "password", autocomplete: "current-password" }))
			.toEqual({ found: true, tag: "INPUT", type: "password", autocomplete: "current-password" });
	});

	it("treats a missing or junk shape as not-found", () => {
		for (const raw of [null, undefined, {}, "nope"]) {
			expect(asElementDescriptor(raw).found).toBe(false);
		}
	});
});

describe("shared scripts", () => {
	it("quote-escape their selectors", () => {
		const sel = `input[name="x'y"]`;
		expect(describeElementScript(sel)).toContain(JSON.stringify(sel));
		expect(readValueScript({ selector: sel })).toContain(JSON.stringify(sel));
	});

	it("read each capture strategy the tool offers", () => {
		expect(readValueScript({ selector: "#a" })).toContain('"sel":"#a"');
		expect(readValueScript({ textSelector: "#b" })).toContain('"textSel":"#b"');
		expect(readValueScript({ attributeSelector: "#c", attribute: "data-token" }))
			.toContain('"attr":"data-token"');
	});
});
