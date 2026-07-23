/**
 * A2 resolution-chain scripts (isolated world) — pure STRING BUILDERS, split
 * from in-app-scripts.ts for the 400-LOC gate: resolutionScript /
 * textSearchScript / selectFillScript plus their shared occlusion and
 * same-origin-frame helpers. The A1 selector scripts and checkedScript stay
 * in in-app-scripts.ts; the drivers (retry/hit-test-fallthrough/real-input)
 * stay in in-app-actions.ts.
 *
 * Same-origin IFRAME descent: extract.ts records iframe elements with
 * frameUrl (the iframe's src attribute, "" for srcdoc/about:blank) and rects
 * OFFSET into main-page coordinates — but until this module the resolution
 * chain queried only the top document, so Stripe/embedded-editor/consent-in-
 * iframe elements always fell through to the fragile coords path (or failed).
 * Now: a frame ref's role/text/xpath strategies search the frame documents
 * (src-matching frames first — CDP actions.resolveFrame parity), hit-test
 * with the FRAME's elementFromPoint at frame-local coords, and map results
 * back to main-page coords (browserInput dispatches in the view's own DIP
 * space). The frame offset is re-read AFTER scrollIntoView because scrolling
 * an iframe element scrolls ancestor documents too. Strategy descent is one
 * level deep, matching extract.ts collectRoots (the coords fallback follows
 * up to two nested hops); cross-origin frames are skipped. A frame candidate
 * whose final main-page point is outside the MAIN viewport (offscreen/
 * clipped/hidden iframes) is rejected — never a dead-air click.
 *
 * Every script runs ONLY in the view's isolated world (1901, enforced in
 * desktop/src/server-bridge-browser.ts). Free identifiers are limited to
 * document / getComputedStyle / devicePixelRatio / visualViewport so the
 * contracts stay unit-testable against a fake DOM (in-app-observe.test.ts).
 */

import type { DurableRef } from "./observation.js";
import { FRAME_HELPERS, OCCLUSION_HELPERS, selectOptionMatchExpr } from "./in-app-script-helpers.js";

/**
 * The whole ref resolution chain in ONE round-trip: role+name → visible text
 * (click only) → XPath → stored coords (click only), each strategy searching
 * the ref's frame roots (main document for main-frame refs). Each candidate is
 * scrolled into view, re-measured, and hit-tested with its document's
 * elementFromPoint; an occluded candidate is recorded in `occluded` and the
 * chain falls through instead of blind-clicking. Returns {found:true, via, x,
 * y, w, h, dpr, zoom, tag, type, editable} (CSS px, MAIN-page viewport-
 * relative) or {found:false, occluded}.
 */
export function resolutionScript(ref: DurableRef, op: "click" | "fill"): string {
	const params = JSON.stringify({
		role: ref.role,
		name: ref.name,
		xpath: ref.xpath,
		frameUrl: ref.frameUrl,
		cx: ref.rect.x,
		cy: ref.rect.y,
		cw: ref.rect.width,
		ch: ref.rect.height,
		op,
	});
	return `(() => {
	const p = ${params};
	const occluded = [];
	const lname = (p.name || "").toLowerCase();
${OCCLUSION_HELPERS}
${FRAME_HELPERS}
	const roots = rootsForRef(p.frameUrl);
	const env = () => ({
		dpr: (typeof devicePixelRatio === "number" && devicePixelRatio) || 1,
		zoom: (typeof visualViewport !== "undefined" && visualViewport && visualViewport.scale) || 1,
	});
	const vis = (el) => {
		if (!el || !el.getBoundingClientRect) return false;
		const r = el.getBoundingClientRect();
		if (r.width <= 0 || r.height <= 0) return false;
		const s = getComputedStyle(el);
		return s.visibility !== "hidden" && s.display !== "none";
	};
	const acc = (el) => (((el.getAttribute && (el.getAttribute("aria-label") || el.getAttribute("placeholder") || "")) || "")
		+ " " + (el.value || "") + " " + (el.textContent || "")).toLowerCase();
	const ROLE_SEL = {
		button: 'button,[role="button"],input[type="button"],input[type="submit"],input[type="reset"]',
		link: 'a[href],[role="link"]',
		textbox: 'input,textarea,[role="textbox"],[contenteditable="true"],[contenteditable=""]',
		searchbox: 'input[type="search"],[role="searchbox"]',
		combobox: 'select,[role="combobox"]',
		checkbox: 'input[type="checkbox"],[role="checkbox"]',
		radio: 'input[type="radio"],[role="radio"]',
		menuitem: '[role="menuitem"]',
		tab: '[role="tab"]',
	};
	// Pierce shadow DOM: elementFromPoint returns the shadow HOST chain's
	// innermost node; contains() never crosses shadow boundaries, so resolve
	// the hit up through its shadow hosts before the relatedness check.
	const hostOf = (n) => {
		let m = n;
		while (m && m.getRootNode) {
			const root = m.getRootNode();
			if (!root || !root.host) break;
			m = root.host;
		}
		return m;
	};
	// Name the occluder — "occluded" alone sent the model blaming the site.
	const describe = (n) => {
		if (!n) return "nothing";
		let d = (n.tagName || "?").toLowerCase();
		if (n.id) d += "#" + n.id;
		else if (typeof n.className === "string" && n.className.trim()) d += "." + n.className.trim().split(/\\s+/)[0];
		return d;
	};
	const finish = (el, root, via, px, py) => {
		// behavior:"instant" is load-bearing: with a page-level scroll-behavior:
		// smooth, scrollIntoView animates and the synchronous re-measure below
		// runs MID-FLIGHT — the hit-test lands on whatever is passing through
		// that point and every strategy false-positives as "occluded".
		if (el.scrollIntoView) el.scrollIntoView({ block: "center", inline: "center", behavior: "instant" });
		const r = el.getBoundingClientRect();
		const x = typeof px === "number" ? px : r.left + r.width / 2;
		const y = typeof py === "number" ? py : r.top + r.height / 2;
		const hit = root.doc.elementFromPoint(x, y);
		const label = hit && hit.closest ? hit.closest("label") : null;
		const hitHost = hostOf(hit);
		const related = !!hit && (hit === el
			|| (el.contains && el.contains(hit))
			|| (hit.contains && hit.contains(el))
			|| (hitHost !== hit && !!hitHost && (hitHost === el
				|| (el.contains && el.contains(hitHost))
				|| (hitHost.contains && hitHost.contains(el))))
			|| (!!label && !!el.id && label.getAttribute("for") === el.id));
		// Frame offset AFTER the scroll — the iframe's rect moves with it.
		const o = frameOffset(root);
		// F1 guard: a frame candidate scrollIntoView could not bring into the
		// MAIN viewport (offscreen/clipped/hidden iframe) must fall through,
		// not report a "clicked" that landed in dead air.
		if (mainViewportMiss(root, x + o.dx, y + o.dy)) {
			occluded.push(via + ":offscreen-frame(" + ((x + o.dx) | 0) + "," + ((y + o.dy) | 0) + ")");
			return null;
		}
		if (!related) {
			if (p.op === "click" && benignOverlap(hit, r, root.doc)) {
				const e2 = env();
				return { found: true, via, x: x + o.dx, y: y + o.dy, w: r.width, h: r.height, dpr: e2.dpr, zoom: e2.zoom,
					tag: el.tagName || "",
					type: ((el.getAttribute && el.getAttribute("type")) || "").toLowerCase(),
					editable: el.isContentEditable === true,
					through: describe(hit) };
			}
			occluded.push(via + ":" + describe(hit));
			return null;
		}
		const e = env();
		return { found: true, via, x: x + o.dx, y: y + o.dy, w: r.width, h: r.height, dpr: e.dpr, zoom: e.zoom,
			tag: el.tagName || "",
			type: ((el.getAttribute && el.getAttribute("type")) || "").toLowerCase(),
			editable: el.isContentEditable === true };
	};
	if (p.role && p.name && ROLE_SEL[p.role]) {
		for (const root of roots) {
			for (const el of root.doc.querySelectorAll(ROLE_SEL[p.role])) {
				if (!vis(el) || !acc(el).includes(lname)) continue;
				const hit = finish(el, root, "role");
				if (hit) return hit;
				break;
			}
		}
	}
	if (p.op === "click" && p.name) {
		for (const root of roots) {
			for (const el of root.doc.querySelectorAll("a,button,[role],label,summary,span,div,li,td,th")) {
				if (!vis(el)) continue;
				if (!(el.textContent || "").toLowerCase().includes(lname)) continue;
				let inner = false;
				for (const c of el.children) if ((c.textContent || "").toLowerCase().includes(lname)) { inner = true; break; }
				if (inner) continue;
				const hit = finish(el, root, "text");
				if (hit) return hit;
				break;
			}
		}
	}
	if (p.xpath) {
		for (const root of roots) {
			try {
				const el = root.doc.evaluate(p.xpath, root.doc, null, 9, null).singleNodeValue;
				if (el && vis(el)) {
					const hit = finish(el, root, "xpath");
					if (hit) return hit;
				}
			} catch { /* stale xpath */ }
		}
	}
	if (p.op === "click" && p.cw > 0 && p.ch > 0) {
		// Stored cx/cy are MAIN-page coords (extract.ts offsets frame rects).
		// If the point lands on an iframe element, descend into its document at
		// frame-local coords so identity verification sees the REAL target, not
		// the frame element.
		let el = document.elementFromPoint(p.cx, p.cy);
		let lx = p.cx, ly = p.cy;
		for (let hops = 0; hops < 2 && el && (el.tagName === "IFRAME" || el.tagName === "FRAME"); hops++) {
			let idoc = null;
			try { idoc = el.contentDocument; } catch { /* cross-origin */ }
			if (!idoc) break;
			const fr = el.getBoundingClientRect();
			lx -= fr.left; ly -= fr.top;
			el = idoc.elementFromPoint(lx, ly);
		}
		if (el) {
			// Every earlier strategy (role+name, text, xpath) missed, so this
			// pixel is UNVERIFIED after a re-layout. Accept a blind coords click
			// ONLY on positive identity: the stored name must actually appear on
			// the hit's role-matching container (known role) or the hit itself
			// (unknown/absent role), and that element must be visible. No stored
			// name, or the name isn't there → reject. Over-reject re-snapshots
			// (safe); a blind click on an unverified hit lands on whatever
			// unrelated control now sits at the point. (Residual: a container
			// whose HIDDEN subtree text contains the generic name as a substring
			// can still over-accept — narrow, name-anchored; see LIVE-VERIFY.)
			const roleSel = p.role && ROLE_SEL[p.role];
			const idEl = roleSel ? (el.closest && el.closest(roleSel)) : el;
			if (lname && idEl && vis(idEl) && acc(idEl).includes(lname)) {
				const e = env();
				return { found: true, via: "coords", x: p.cx, y: p.cy, w: p.cw, h: p.ch, dpr: e.dpr, zoom: e.zoom,
					tag: el.tagName || "", type: ((el.getAttribute && el.getAttribute("type")) || "").toLowerCase(),
					editable: el.isContentEditable === true };
			}
			occluded.push("coords:" + describe(el) + " — element moved or was replaced, re-snapshot");
		} else {
			// elementFromPoint returned null → the stored point is outside the
			// current viewport (page scrolled/re-laid-out since the observation).
			occluded.push("coords:offscreen(" + ((p.cx | 0)) + "," + ((p.cy | 0)) + ")");
		}
	}
	return { found: false, occluded };
})()`;
}

/** clickByText search across the main document AND same-origin frames:
 *  clickable elements first (exact matches preferred), then any innermost
 *  visible element containing the text. Occluded candidates are skipped,
 *  never blind-clicked. Returned x/y are MAIN-page coords. */
export function textSearchScript(text: string): string {
	return `(() => {
	const q = ${JSON.stringify(text)}.toLowerCase();
${OCCLUSION_HELPERS}
${FRAME_HELPERS}
	const roots = [{ doc: document, frameEl: null }].concat(sameOriginRoots());
	const CLICKABLE = 'a[href],button,[role="button"],[role="link"],[role="menuitem"],[role="tab"],[role="checkbox"],input[type="submit"],input[type="button"],label';
	const vis = (el) => {
		if (!el || !el.getBoundingClientRect) return false;
		const r = el.getBoundingClientRect();
		if (r.width <= 0 || r.height <= 0) return false;
		const s = getComputedStyle(el);
		return s.visibility !== "hidden" && s.display !== "none";
	};
	const leafText = (el) => (el.textContent || "").trim().toLowerCase();
	const roleOf = (el) => ((el.getAttribute && el.getAttribute("role")) || ({ A: "link", BUTTON: "button" })[el.tagName] || "");
	const picks = [];
	for (const root of roots) {
		for (const el of root.doc.querySelectorAll(CLICKABLE)) {
			if (!vis(el)) continue;
			const t = leafText(el);
			if (!t.includes(q)) continue;
			picks.push([t === q ? 5 : 2, el, root]);
		}
	}
	if (picks.length === 0) {
		for (const root of roots) {
			for (const el of root.doc.querySelectorAll("*")) {
				if (!vis(el)) continue;
				const t = leafText(el);
				if (!t.includes(q)) continue;
				let inner = false;
				for (const c of el.children) if ((c.textContent || "").toLowerCase().includes(q)) { inner = true; break; }
				if (!inner) picks.push([t === q ? 3 : 0, el, root]);
			}
		}
	}
	picks.sort((a, b) => b[0] - a[0]);
	// On a tie at the top score the DOM order carries no signal — prefer a
	// candidate already in its viewport so the click is predictable, and warn
	// the model the match was ambiguous so it can disambiguate with a ref.
	const top = picks.length ? picks[0][0] : -1;
	const tied = picks.filter((pk) => pk[0] === top).length;
	const inVp = (e, dd) => { const r = e.getBoundingClientRect(); const de = dd.documentElement; const vw = (de && de.clientWidth) || 1; const vh = (de && de.clientHeight) || 1; return r.bottom > 0 && r.right > 0 && r.top < vh && r.left < vw; };
	if (tied > 1) picks.sort((a, b) => (b[0] - a[0]) || ((inVp(b[1], b[2].doc) ? 1 : 0) - (inVp(a[1], a[2].doc) ? 1 : 0)));
	for (const pick of picks) {
		const el = pick[1];
		const root = pick[2];
		// instant: a smooth-scrolling page would animate past the synchronous
		// re-measure below (same hazard as resolutionScript's finish()).
		if (el.scrollIntoView) el.scrollIntoView({ block: "center", inline: "center", behavior: "instant" });
		const r = el.getBoundingClientRect();
		const x = r.left + r.width / 2, y = r.top + r.height / 2;
		const hit = root.doc.elementFromPoint(x, y);
		const related = !!hit && (hit === el || (el.contains && el.contains(hit)) || (hit.contains && hit.contains(el)));
		if (!related && !benignOverlap(hit, r, root.doc)) continue;
		const o = frameOffset(root); // AFTER the scroll — the frame rect moves with it
		if (mainViewportMiss(root, x + o.dx, y + o.dy)) continue; // offscreen frame — never a dead-air click
		const res = { found: true, role: roleOf(el), x: x + o.dx, y: y + o.dy,
			dpr: (typeof devicePixelRatio === "number" && devicePixelRatio) || 1,
			zoom: (typeof visualViewport !== "undefined" && visualViewport && visualViewport.scale) || 1 };
		if (tied > 1) res.note = 'matched ' + tied + ' elements for "' + ${JSON.stringify(text)} + '", clicked the first visible — use a ref to target a specific one';
		return res;
	}
	return { found: false };
})()`;
}

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
