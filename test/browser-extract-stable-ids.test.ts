// @vitest-environment happy-dom
/**
 * Extraction contract for durable identity — the 2026-07-25 class fix.
 *
 * Pins the three extraction defects that made the Thrive/Shopventory PO form
 * undrivable, each against a real DOM rather than a fake one:
 *   1. stable identifiers (unique id / test hook / HTML name / placeholder)
 *      were computed and thrown away, leaving only a fuzzy accessible name,
 *   2. everything per-element resolved against the TOP document, so a
 *      same-origin iframe's fields lost their labels and never qualified for
 *      an id-anchored XPath, and
 *   3. a signature collision DROPPED elements — the three ui-select focussers
 *      (id=focusser-0/1/2) collapsed into one addressable ref.
 *
 * happy-dom does no layout, so rects are stubbed; nothing here depends on the
 * geometry beyond "the element has a box". Lives under test/ rather than beside
 * extract.ts because the root tsconfig compiles src/ without the DOM lib.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { EXTRACTOR_SCRIPT, type RawElement } from "../src/browser/extract.js";

const BOX = { x: 10, y: 20, width: 120, height: 24, top: 20, left: 10, right: 130, bottom: 44 };

beforeEach(() => {
	document.body.innerHTML = "";
	// happy-dom returns a zero rect for everything and the extractor drops
	// zero-size elements; give every element the same non-empty box.
	Element.prototype.getBoundingClientRect = () => ({ ...BOX }) as DOMRect;
	Element.prototype.getClientRects = () => [{ ...BOX }] as unknown as DOMRectList;
	if (typeof (globalThis as { CSS?: unknown }).CSS === "undefined") {
		(globalThis as { CSS?: unknown }).CSS = { escape: (s: string) => s.replace(/([^\w-])/g, "\\$1") };
	}
});

function extract(): RawElement[] {
	return new Function(`return ${EXTRACTOR_SCRIPT}`)()({ vpWidth: 1280, vpHeight: 800 }) as RawElement[];
}

function byName(els: RawElement[], name: string): RawElement | undefined {
	return els.find((e) => e.name === name);
}

describe("extractor: stable identifiers", () => {
	it("records the PO field's unique id and HTML name (the fields resolution needs)", () => {
		document.body.innerHTML = `<input id="po-number" name="PO NUMBER" placeholder="">`;
		const po = extract()[0];
		expect(po.ids).toEqual({ id: "po-number", name: "PO NUMBER" });
		// The observed name still comes from the HTML name attribute — that part
		// was never the bug; the bug was having nothing else to match on.
		expect(po.name).toBe("PO NUMBER");
	});

	it("records a test hook, preferring data-testid over the other spellings", () => {
		document.body.innerHTML = `<button data-test="b" data-testid="submit-po">Submit</button>`;
		expect(extract()[0].ids).toEqual({ testId: "submit-po" });
	});

	it("records a placeholder as the weakest identifier", () => {
		document.body.innerHTML = `<textarea placeholder="Message to vendor"></textarea>`;
		expect(extract()[0].ids).toEqual({ placeholder: "Message to vendor" });
	});

	it("refuses a DUPLICATED id — it resolves to whichever copy comes first, so it is not identity", () => {
		document.body.innerHTML = `<input id="dup" name="a"><input id="dup" name="b">`;
		for (const el of extract()) expect(el.ids?.id).toBeUndefined();
	});

	it("omits ids entirely for an element with no durable identity", () => {
		document.body.innerHTML = `<button>Save</button>`;
		expect(extract()[0].ids).toBeUndefined();
	});

	it("rejects a control-character / over-long value instead of building a broken selector", () => {
		document.body.innerHTML = `<input name="a${String.fromCharCode(10)}b" placeholder="${"x".repeat(201)}">`;
		expect(extract()[0].ids).toBeUndefined();
	});
});

describe("extractor: signature collisions no longer drop elements", () => {
	it("keeps all three ui-select focussers addressable (they share one base signature)", () => {
		// The live shape: identical ancestors, no name, no text — only the id
		// differs. Before the fix dedup kept ONE and the other two vanished.
		document.body.innerHTML = `
			<div><div><div><input id="focusser-0" type="text"></div></div></div>
			<div><div><div><input id="focusser-1" type="text"></div></div></div>
			<div><div><div><input id="focusser-2" type="text"></div></div></div>`;
		const els = extract();
		expect(els.map((e) => e.ids?.id).sort()).toEqual(["focusser-0", "focusser-1", "focusser-2"]);
		expect(new Set(els.map((e) => e.signature)).size).toBe(3);
	});

	it("leaves a NON-colliding element's signature byte-identical (refs stay durable)", () => {
		document.body.innerHTML = `<button id="save-btn">Save</button>`;
		const [only] = extract();
		expect(only.signature).not.toContain("@");
		expect(only.signature).toContain("Save");
	});

	it("still collapses colliding elements that have nothing durable to tell them apart", () => {
		document.body.innerHTML = `<div><span role="button"></span><span role="button"></span></div>`;
		expect(extract().length).toBeLessThanOrEqual(1);
	});
});

/**
 * happy-dom has no document.evaluate, so the path is resolved by hand: walk the
 * segments from the document root and check we land on the element we started
 * from. That is the property that matters — the previous "/div[1]/input[1]"
 * form was well-formed but described a <div> child of the DOCUMENT node, which
 * cannot exist in HTML, so it resolved to nothing. (Confirmed in Chromium; the
 * real-browser round-trip runs in test/smoke/browser-observation.ts.)
 */
function resolveByHand(xpath: string, root: Document | Element): Element | null {
	if (!xpath.startsWith("/") || xpath.startsWith("//")) return null;
	let node: Document | Element = root;
	for (const step of xpath.slice(1).split("/")) {
		const m = /^([a-z0-9-]+)\[(\d+)\]$/.exec(step);
		if (!m) return null;
		const matches = Array.from(node.children).filter((c) => c.tagName.toLowerCase() === m[1]);
		const next = matches[Number(m[2]) - 1];
		if (!next) return null;
		node = next;
	}
	return node === root ? null : (node as Element);
}

describe("extractor: the XPath fallback resolves back to its element", () => {
	it("emits a document-rooted path for an element with no id (it used to match nothing)", () => {
		document.body.innerHTML = `<div><form><input name="q"></form></div>`;
		const field = extract()[0];
		expect(field.xpath.startsWith("/html[")).toBe(true);
		expect(resolveByHand(field.xpath, document)).toBe(document.querySelector("input"));
	});

	it("anchors at the nearest unique-id ANCESTOR when there is one", () => {
		document.body.innerHTML = `<div id="po-form"><fieldset><input name="q"></fieldset></div>`;
		expect(extract()[0].xpath).toBe('//*[@id="po-form"]/fieldset[1]/input[1]');
	});

	it("still prefers the element's own unique id over any path", () => {
		document.body.innerHTML = `<div id="wrap"><input id="po-number" name="q"></div>`;
		expect(extract()[0].xpath).toBe('//*[@id="po-number"]');
	});

	it("counts same-tag siblings so the path picks the right one of several", () => {
		document.body.innerHTML = `<div id="rows"><p><input name="a"></p><p><input name="b"></p></div>`;
		const second = extract().find((e) => e.ids?.name === "b");
		expect(second?.xpath).toBe('//*[@id="rows"]/p[2]/input[1]');
	});
});

describe("extractor: per-document resolution inside same-origin iframes", () => {
	const FRAME_SRC = "https://app.example.com/po";

	/** A same-origin iframe whose document we control. The src is reported via
	 *  getAttribute rather than SET: happy-dom would otherwise try to actually
	 *  load the URL, and a unit test must not touch the network. */
	function withFrame(inner: string): Document {
		const frameDoc = document.implementation.createHTMLDocument("frame");
		frameDoc.body.innerHTML = inner;
		const iframe = document.createElement("iframe");
		document.body.appendChild(iframe);
		Object.defineProperty(iframe, "contentDocument", { get: () => frameDoc });
		const inherited = iframe.getAttribute.bind(iframe);
		iframe.getAttribute = (name: string) => (name === "src" ? FRAME_SRC : inherited(name));
		return frameDoc;
	}

	it("derives the label and the id-anchored XPath from the FRAME's document, not the top one", () => {
		// Before the fix both lookups queried the main document — where neither
		// the label nor the id exists — so the field got an anonymous name and an
		// 8-deep index XPath that rots on the first AngularJS re-render.
		withFrame(`<label for="fees">Fees</label><input id="fees" name="FEES">`);
		const field = extract().find((e) => e.tag === "INPUT");
		expect(field?.name).toBe("Fees");
		expect(field?.xpath).toBe('//*[@id="fees"]');
		expect(field?.ids).toEqual({ id: "fees", name: "FEES" });
		expect(field?.frameUrl).toBe(FRAME_SRC);
	});

	it("scopes id-uniqueness per document — the same id in the frame and the page stays usable", () => {
		withFrame(`<input id="notes" name="frame-notes">`);
		const page = document.createElement("input");
		page.id = "notes";
		page.setAttribute("name", "page-notes");
		document.body.appendChild(page);
		const fields = extract().filter((e) => e.tag === "INPUT");
		expect(fields).toHaveLength(2);
		for (const f of fields) expect(f.ids?.id).toBe("notes");
	});
});
