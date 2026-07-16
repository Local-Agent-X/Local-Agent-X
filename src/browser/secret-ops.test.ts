// The one seam where plaintext touches a live page. These pin the properties
// that keep it from escaping: the verdict is computed in the page (so the value
// never makes the return trip), unknown shapes fail closed, and the scripts both
// backends run are the same text.
import { describe, it, expect, vi } from "vitest";

vi.mock("./bridge-client.js", async (importOriginal) => {
	const actual = await importOriginal<typeof import("./bridge-client.js")>();
	return { ...actual, browserExec: vi.fn(), browserInput: vi.fn() };
});

import { browserExec, browserInput } from "./bridge-client.js";
import {
	asElementDescriptor,
	asFillOutcome,
	createInAppSecretOps,
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

	it("generates syntactically valid JS even for hostile values", () => {
		// String pins can't catch a template slip that breaks the script itself.
		const nasty = `a"b\\c'; alert(1); // `;
		for (const script of [fillSecretScript("#pw", nasty), describeElementScript("#pw"), readValueScript({ selector: "#pw" })]) {
			expect(() => new Function(`return ${script}`)).not.toThrow();
		}
	});

	it("writes through the prototype's native value setter, not plain assignment", () => {
		// React (>=16) dedupes synthetic input events against its own value
		// tracker on the element instance; a bare `el.value =` write updates the
		// tracker too, so onChange never fires and framework state stays empty —
		// while reading back as "landed". The native prototype setter bypasses
		// the instance tracker. Plain assignment must survive only as the
		// fallback for exotic value-bearing elements.
		const script = fillSecretScript("#pw", SECRET);
		expect(script).toContain('Object.getOwnPropertyDescriptor(proto, "value")');
		expect(script).toContain(`desc.set.call(el, ${JSON.stringify(SECRET)})`);
		expect(script).toContain("HTMLTextAreaElement.prototype");
		// The bare assignment appears exactly once — the else-branch fallback.
		const bareAssigns = script.match(/el\.value = /g) ?? [];
		expect(bareAssigns).toHaveLength(1);
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

describe("createInAppSecretOps", () => {
	it("resolves the viewId at CALL time — a tab switch between ops retargets them", async () => {
		vi.mocked(browserExec).mockResolvedValue("https://a.example/");
		vi.mocked(browserInput).mockResolvedValue(undefined);
		let active = "view-a";
		const ops = createInAppSecretOps({ viewId: () => active, ensureView: async () => { /* mounted */ } });

		await ops.currentOrigin();
		expect(vi.mocked(browserExec).mock.calls.at(-1)?.[0]).toBe("view-a");

		active = "view-b"; // the backend's active tab changed (switch_tab)
		await ops.currentOrigin();
		expect(vi.mocked(browserExec).mock.calls.at(-1)?.[0]).toBe("view-b");

		// pressEnter: the focus exec AND all three key events hit the same live view.
		await ops.pressEnter("#pw");
		expect(vi.mocked(browserExec).mock.calls.at(-1)?.[0]).toBe("view-b");
		for (const call of vi.mocked(browserInput).mock.calls) expect(call[0]).toBe("view-b");
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
