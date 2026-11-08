/**
 * Upload scripts (isolated world) — pure STRING BUILDERS for the two in-page
 * halves of in-app-upload.ts:
 *
 *   - fileInputMarkScript: find the `<input type=file>` a ref names WITHOUT a
 *     visibility or hit-test requirement, and stamp it with the upload mark.
 *     Nearly every real upload control hides its input (display:none, 1×1,
 *     opacity 0) behind a styled label or button, so the click/fill
 *     resolution chain — which refuses anything it cannot hit-test — never
 *     reaches it. Identity, not pixels, is what an upload needs: the desktop
 *     then hands the files to the marked node through the DOM domain
 *     (desktop/src/browser-file-upload.ts).
 *   - uploadReadbackScript: what the marked input holds after the desktop's
 *     op (names and sizes of OUR files — never page content), then clears the
 *     mark. Read from the isolated world, whose `files` getter the page's
 *     main-world script cannot replace.
 *
 * Same discipline as the sibling script builders (in-app-resolve-scripts.ts
 * header): isolated world only, free identifiers limited to the DOM globals.
 */

import type { DurableRef } from "./observation.js";
import { FRAME_HELPERS } from "./in-app-script-helpers.js";
import { stableSelectors } from "./stable-ids.js";

/** The attribute the resolution chain and this script stamp on their target;
 *  the desktop finds the upload target by it. */
export const UPLOAD_MARK_ATTR = "data-lax-ref";

/**
 * Stamp the file input the ref names. Strategies, in order of certainty:
 * exact stable identifier → the ref's XPath → a file input whose identity
 * text (aria-label / name / id / title) carries the ref's name → the page's
 * only file input (a form with one upload control is the everyday case, and
 * the ref the model holds is that control under whatever label it was
 * observed). Every candidate must BE an `<input type=file>`; a label or
 * button resolves to the input it controls. Returns {ok:true, via, key?} or
 * {ok:false, error:"not-found"}.
 */
export function fileInputMarkScript(ref: DurableRef, mark: string): string {
	const params = JSON.stringify({
		mark,
		name: ref.name,
		xpath: ref.xpath,
		frameUrl: ref.frameUrl,
		exact: stableSelectors(ref.ids, ref.tag),
		attr: UPLOAD_MARK_ATTR,
	});
	return `(() => {
	const p = ${params};
${FRAME_HELPERS}
	const roots = rootsForRef(p.frameUrl);
	const isFile = (el) => !!el && el.tagName === "INPUT" && ((el.getAttribute("type") || "").toLowerCase() === "file");
	// A <label for=…> or a label wrapping the input stands for the input.
	const asFileInput = (el) => {
		if (!el) return null;
		if (isFile(el)) return el;
		if (el.tagName === "LABEL") {
			const c = el.control || (el.htmlFor && el.ownerDocument.getElementById(el.htmlFor)) || el.querySelector('input[type="file"]');
			if (isFile(c)) return c;
		}
		const inner = el.querySelector && el.querySelector('input[type="file"]');
		return isFile(inner) ? inner : null;
	};
	const done = (el, via, key) => {
		for (const root of roots) for (const old of root.doc.querySelectorAll("[" + p.attr + "]")) old.removeAttribute(p.attr);
		el.setAttribute(p.attr, p.mark);
		return key ? { ok: true, via, key } : { ok: true, via };
	};
	for (const s of p.exact) {
		for (const root of roots) {
			let el = null;
			try { el = asFileInput(root.doc.querySelector(s.sel)); } catch { continue; }
			if (el) return done(el, "exact", s.key);
		}
	}
	if (p.xpath) {
		for (const root of roots) {
			let el = null;
			try { el = asFileInput(root.doc.evaluate(p.xpath, root.doc, null, 9, null).singleNodeValue); } catch { /* stale */ }
			if (el) return done(el, "xpath");
		}
	}
	const lname = (p.name || "").toLowerCase();
	const all = [];
	for (const root of roots) for (const el of root.doc.querySelectorAll('input[type="file"]')) all.push(el);
	if (lname) {
		for (const el of all) {
			const at = (n) => (el.getAttribute(n) || "");
			const ident = (at("aria-label") + " " + at("name") + " " + at("id") + " " + at("title") + " " + ((el.labels && el.labels[0] && el.labels[0].textContent) || "")).toLowerCase();
			if (ident.includes(lname)) return done(el, "name");
		}
	}
	if (all.length === 1) return done(all[0], "only-file-input");
	return { ok: false, error: "not-found" };
})()`;
}

/** What the marked input holds now: {ok:true, names, sizes, multiple}. The
 *  mark is removed on the way out; {ok:false, error:"not-found"} when no
 *  element carries it any more. */
export function uploadReadbackScript(mark: string): string {
	const params = JSON.stringify({ mark, attr: UPLOAD_MARK_ATTR });
	return `(() => {
	const p = ${params};
${FRAME_HELPERS}
	const roots = [{ doc: document, frameEl: null }].concat(sameOriginRoots());
	const sel = "[" + p.attr + "=" + JSON.stringify(p.mark) + "]";
	for (const root of roots) {
		let el = null;
		try { el = root.doc.querySelector(sel); } catch { continue; }
		if (!el) continue;
		el.removeAttribute(p.attr);
		const files = el.files ? Array.from(el.files) : [];
		return { ok: true, names: files.map((f) => String(f.name)), sizes: files.map((f) => Number(f.size) || 0), multiple: el.multiple === true };
	}
	return { ok: false, error: "not-found" };
})()`;
}
