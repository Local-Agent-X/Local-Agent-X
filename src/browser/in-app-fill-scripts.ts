/**
 * In-app fill scripts (isolated world) — pure STRING BUILDERS for the two fill
 * paths that do NOT go through synthetic mouse/keyboard input:
 *
 *   - selectFillScript: <select> is never typed into; CDP parity is .value +
 *     input/change events.
 *   - stableFillScript: the EXACT-identity fill. in-app fills normally click
 *     the resolved point and type real key events (isTrusted-gated pages need
 *     that), which means a fill dies whenever the hit-test refuses the point —
 *     covered by an overlay, clipped by a scroll container, in an iframe that
 *     can't be brought fully into the main viewport. When the ref carries a
 *     durable identifier (stable-ids.ts) the element's IDENTITY is not in
 *     doubt, only its pixels are, so the write goes straight to the DOM node.
 *     This is the same reach the CDP path already has: Playwright's fill()
 *     checks visible/enabled/editable but never occlusion, so it writes
 *     through an overlay too. Used only AFTER the coordinate path has missed.
 *
 * Split from in-app-resolve-scripts.ts for the 400-LOC gate. Same isolated-
 * world discipline as its siblings (see in-app-resolve-scripts.ts header).
 */

import type { DurableRef } from "./observation.js";
import { FRAME_HELPERS, nativeValueSetStmt, selectOptionMatchExpr } from "./in-app-script-helpers.js";
import { stableSelectors } from "./stable-ids.js";

/** <select> fill: CDP parity — never typed; .value + input/change events.
 *  Searches the ref's frame roots (main document for main-frame refs). */
export function selectFillScript(ref: DurableRef, value: string): string {
	const params = JSON.stringify({ xpath: ref.xpath, name: ref.name, frameUrl: ref.frameUrl, value });
	return `(() => {
	const p = ${params};
${FRAME_HELPERS}
	const roots = rootsForRef(p.frameUrl);
	let el = null;
	if (p.xpath) {
		for (const root of roots) {
			try { el = root.doc.evaluate(p.xpath, root.doc, null, 9, null).singleNodeValue; } catch { /* stale */ }
			if (el && el.tagName === "SELECT") break;
			el = null;
		}
	}
	if (!el) {
		const lname = (p.name || "").toLowerCase();
		outer: for (const root of roots) {
			for (const c of root.doc.querySelectorAll("select")) {
				const acc = (((c.getAttribute("aria-label") || "") + " " + (c.name || "") + " " + (c.id || ""))).toLowerCase();
				if (!lname || acc.includes(lname)) { el = c; break outer; }
			}
		}
	}
	if (!el || el.tagName !== "SELECT") return { ok: false, error: "not-found" };
	const match = ${selectOptionMatchExpr("[...el.options]", "p.value")};
	if (!match) return { ok: false, error: "no-matching-option" };
	el.value = match.value;
	el.dispatchEvent(new Event("input", { bubbles: true }));
	el.dispatchEvent(new Event("change", { bubbles: true }));
	return { ok: true, selected: [match.value] };
})()`;
}

/**
 * Write `value` into the element the ref's stable identifier names, without
 * any coordinate/hit-test dependency. Returns { ok:true, key } naming the key
 * that matched (never the field's value — an echo of what was typed is exactly
 * the read-into-model-context class guards.ts blocks), or a typed error.
 *
 * The value is written through the prototype's native setter so React's value
 * tracker doesn't swallow the change, then input+change are dispatched — the
 * same contract as the A1 selector fill.
 */
export function stableFillScript(ref: DurableRef, value: string): string {
	const params = JSON.stringify({ exact: stableSelectors(ref.ids, ref.tag), frameUrl: ref.frameUrl, value });
	return `(() => {
	const p = ${params};
${FRAME_HELPERS}
	const roots = rootsForRef(p.frameUrl);
	for (const s of p.exact) {
		for (const root of roots) {
			let el = null;
			try { el = root.doc.querySelector(s.sel); } catch { continue; }
			if (!el) continue;
			const type = ((el.getAttribute && el.getAttribute("type")) || "").toLowerCase();
			// A native picker and a <select> are not text sinks — refuse loudly
			// rather than writing a value the widget will ignore.
			if (type === "file") return { ok: false, error: "file-input" };
			if (el.tagName === "SELECT") return { ok: false, error: "not-fillable" };
			if ("value" in el) { ${nativeValueSetStmt("el", "p.value")} }
			else if (el.isContentEditable) el.textContent = p.value;
			else continue;
			el.dispatchEvent(new Event("input", { bubbles: true }));
			el.dispatchEvent(new Event("change", { bubbles: true }));
			return { ok: true, key: s.key };
		}
	}
	return { ok: false, error: "not-found" };
})()`;
}
