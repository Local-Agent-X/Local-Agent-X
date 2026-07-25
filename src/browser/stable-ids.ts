/**
 * Stable element identifiers — the ONE definition of which attributes make an
 * element addressable across re-renders, and how they become EXACT selectors.
 *
 * Why this module exists (the 2026-07-25 class fix): a DurableRef used to carry
 * only a fuzzy accessible `name`, an index XPath and stored coordinates. So
 * resolution was fuzzy end to end — `getByRole({name})` ignores the HTML `name`
 * attribute, an index XPath rots on the first re-render, and coordinates rot on
 * the first re-layout. Elements that DO have durable identity (`<input
 * id="po-number" name="PO NUMBER">` in the Thrive/Shopventory PO form) were
 * observed under a name no strategy could match back, and every fill died with
 * "all resolution strategies failed".
 *
 * Extraction (extract.ts computeIds) records these; both resolution chains
 * (in-app bridge resolutionScript, CDP actions.ts tryResolutionChain) try the
 * selectors below BEFORE the fuzzy name/text/xpath/coords chain. Same list,
 * same order, same escaping on both paths — that shared contract is the point
 * of putting them here rather than in either chain.
 */

/**
 * The durable identity of an element, as observed. Every field is optional: an
 * element with none of them is only addressable fuzzily (and that is exactly
 * the case the fallback chain still covers).
 */
export interface StableIds {
	/** DOM id — recorded ONLY when unique in its own document. A duplicated id
	 *  is not an identifier: it resolves to whichever copy comes first. */
	id?: string;
	/** HTML `name` attribute. Durable for form fields; may be shared (radio
	 *  groups), so callers must disambiguate rather than assume uniqueness. */
	name?: string;
	/** placeholder text — weakest of the four (repeats, gets localized). */
	placeholder?: string;
	/** First present value among TEST_ID_ATTRS. */
	testId?: string;
}

/** Test-hook attributes, in precedence order. Kept here so the extractor and
 *  the selector builder can never drift apart. */
export const TEST_ID_ATTRS = ["data-testid", "data-test", "data-qa", "data-cy"] as const;

/** Values longer than this are page CONTENT, not identity (a paragraph pasted
 *  into a placeholder); they also make unwieldy selectors. */
export const STABLE_ID_MAX_LEN = 200;

/** Which stable key a resolution used — surfaced to the model so a successful
 *  action says WHY it was confident, and a wrong element is diagnosable. */
export type StableVia = "id" | "testid" | "name" | "placeholder";

export interface StableSelector {
	via: StableVia;
	/** CSS selector, ready for querySelectorAll / Playwright locator(). */
	sel: string;
	/** Human-readable form for messages, e.g. `id="po-number"`. */
	key: string;
}

/** Control characters (C0 and DEL) can't appear in a CSS string, and a value
 *  carrying one is page content rather than identity. Tested by code point so
 *  this source file needs no raw control characters of its own. */
function hasControlChar(v: string): boolean {
	for (let i = 0; i < v.length; i++) {
		const c = v.charCodeAt(i);
		if (c < 0x20 || c === 0x7f) return true;
	}
	return false;
}

/**
 * True when `value` is usable as an identifier. Rejects empties, over-long
 * values, and anything carrying a control character.
 */
export function isUsableIdValue(value: unknown): value is string {
	if (typeof value !== "string") return false;
	const v = value.trim();
	return v.length > 0 && v.length <= STABLE_ID_MAX_LEN && !hasControlChar(v);
}

/**
 * `[attr="value"]` with the value escaped for a CSS string. Only `\` and `"`
 * need escaping once isUsableIdValue has excluded control characters.
 */
export function attrSelector(attr: string, value: string): string {
	return `[${attr}="${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"]`;
}

/**
 * A tag prefix constrains an exact selector to the element KIND the ref was
 * observed as, so a ref for an `<input>` can never resolve to the `<label>`
 * that happens to carry the same data-testid.
 *
 * ONLY an all-uppercase tagName qualifies — that is exactly the set an HTML
 * document produces. CSS type selectors are case-insensitive in HTML but NOT
 * in SVG/XML, so lowercasing a case-preserved tag (`clipPath`,
 * `foreignObject`, an XHTML `input`) would emit a selector matching nothing
 * and silently kill the strategy. Those refs go untagged instead: a slightly
 * wider match beats a dead one.
 */
function tagPrefix(tag?: string): string {
	return tag && /^[A-Z]+$/.test(tag) ? tag.toLowerCase() : "";
}

/**
 * The ordered exact-resolution strategies for a ref, strongest first:
 * unique id → test hook → HTML name → placeholder. An empty array means the
 * element has no durable identity and only the fuzzy chain applies.
 *
 * `tag` is the ref's observed tagName; pass it whenever available.
 */
export function stableSelectors(ids: StableIds | undefined, tag?: string): StableSelector[] {
	if (!ids) return [];
	const t = tagPrefix(tag);
	const out: StableSelector[] = [];
	const add = (via: StableVia, attrs: readonly string[], value: unknown): void => {
		if (!isUsableIdValue(value)) return;
		const v = value.trim();
		out.push({
			via,
			sel: attrs.map((a) => t + attrSelector(a, v)).join(","),
			key: `${attrs[0]}="${v}"`,
		});
	};
	add("id", ["id"], ids.id);
	add("testid", TEST_ID_ATTRS, ids.testId);
	add("name", ["name"], ids.name);
	add("placeholder", ["placeholder"], ids.placeholder);
	return out;
}

/** Whether a ref can be resolved exactly at all. */
export function hasStableIds(ids: StableIds | undefined): boolean {
	return stableSelectors(ids).length > 0;
}
