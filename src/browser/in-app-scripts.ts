/**
 * Isolated-world page scripts for the in-app backend — pure STRING BUILDERS,
 * split from in-app-observe.ts for the 400-LOC gate:
 *   - checkedScript: the error-surfacing wrapper (execChecked in
 *     in-app-observe.ts pairs it with browserExec),
 *   - A1 selector scripts (click/fill/select),
 *   - the A2 resolution chain (resolutionScript / textSearchScript /
 *     selectFillScript).
 *
 * Every script runs ONLY in the view's isolated world (1901, enforced in
 * desktop/src/server-bridge-browser.ts). Free identifiers are limited to
 * document / getComputedStyle / devicePixelRatio / visualViewport so the
 * contracts stay unit-testable against a fake DOM (in-app-observe.test.ts).
 */

import type { DurableRef } from "./observation.js";
import { selectorQuery } from "./selector-compat.js";
import { nativeValueSetStmt, selectOptionMatchExpr } from "./in-app-script-helpers.js";

/**
 * Wrap an expression script so an in-page throw comes back as a marker object
 * carrying the REAL error. Without this, Electron rejects with the generic
 * "Script failed to execute, this normally means an error was thrown. Check
 * the renderer console for the error." — undiagnosable from server logs, and
 * it read to the agent as a broken site (2026-07-20, Thrive PO page).
 */
export function checkedScript(script: string): string {
	return `(() => { try { const __r = (${script}); return (__r && typeof __r.then === "function") ? __r.then((v) => v, (e) => ({ __laxScriptError: String((e && (e.stack || e.message)) || e) })) : __r; } catch (e) { return { __laxScriptError: String((e && (e.stack || e.message)) || e) }; } })()`;
}

export interface ExecActionResult {
	ok: boolean;
	error?: string;
	actual?: unknown;
	type?: string;
	selected?: unknown;
}

export function asExecResult(raw: unknown): ExecActionResult {
	if (raw && typeof raw === "object" && typeof (raw as { ok?: unknown }).ok === "boolean") {
		return raw as ExecActionResult;
	}
	return { ok: false, error: "unexpected exec result shape" };
}

// A1 scripts resolve their selector through the compat engine (selector-compat
// .ts): Playwright idioms the model emits (text=, :has-text(), >>) work, and a
// selector the browser itself rejects returns a typed "invalid-selector" error
// instead of an in-page SyntaxError throw.

export function clickScript(selector: string): string {
	return `(() => {
	const el = ${selectorQuery(selector)};
	if (el && el.bad) return { ok: false, error: "invalid-selector: " + el.bad };
	if (!el) return { ok: false, error: "not-found" };
	if (typeof el.click !== "function") return { ok: false, error: "not-clickable" };
	el.scrollIntoView({ block: "center", inline: "center", behavior: "instant" });
	el.click();
	return { ok: true };
})()`;
}

export function fillScript(selector: string, value: string): string {
	const val = JSON.stringify(value);
	return `(() => {
	const el = ${selectorQuery(selector)};
	if (el && el.bad) return { ok: false, error: "invalid-selector: " + el.bad };
	if (!el) return { ok: false, error: "not-found" };
	const type = ((el.getAttribute && el.getAttribute("type")) || "").toLowerCase();
	if ("value" in el) { ${nativeValueSetStmt("el", val)} }
	else if (el.isContentEditable) el.textContent = ${val};
	else return { ok: false, error: "not-fillable" };
	el.dispatchEvent(new Event("input", { bubbles: true }));
	el.dispatchEvent(new Event("change", { bubbles: true }));
	return { ok: true, actual: "value" in el ? el.value : el.textContent, type };
})()`;
}

export function selectScript(selector: string, value: string): string {
	const val = JSON.stringify(value);
	return `(() => {
	const el = ${selectorQuery(selector)};
	if (el && el.bad) return { ok: false, error: "invalid-selector: " + el.bad };
	if (!el) return { ok: false, error: "not-found" };
	if (el.tagName !== "SELECT") return { ok: false, error: "not-a-select" };
	const match = ${selectOptionMatchExpr("[...el.options]", val)};
	if (!match) return { ok: false, error: "no-matching-option" };
	el.value = match.value;
	el.dispatchEvent(new Event("input", { bubbles: true }));
	el.dispatchEvent(new Event("change", { bubbles: true }));
	return { ok: true, selected: [match.value] };
})()`;
}

// ── A2 resolution-chain scripts (isolated world) ─────────
// Pure string builders consumed by the in-app-actions.ts drivers. They live
// here beside the A1 scripts so all isolated-world page code shares one home;
// the drivers (retry/hit-test-fallthrough/real-input) stay in in-app-actions.ts.

/**
 * Occlusion classification, shared by resolutionScript and textSearchScript.
 * A failed hit-test does NOT always mean a blocking overlay: cosmetic siblings
 * (icons, ripple spans, styled sibling elements) routinely sit on top of the
 * target without being DOM-related — and a HUMAN click lands on exactly that
 * topmost element. Those are BENIGN: dispatch the click at the point anyway.
 * Blocking overlays (modals, backdrops, toasts, full-viewport fixed layers)
 * stay refused, so the model gets the named occluder instead of a blind click.
 * Benign requires the overlapper to be small (≤2× the target's area) and to
 * sit mostly WITHIN the target's bounds — a nav bar or banner covering the
 * point fails both and stays a refusal.
 */
const OCCLUSION_HELPERS = `
	const overlayLike = (n) => {
		const vw = document.documentElement.clientWidth || 1;
		const vh = document.documentElement.clientHeight || 1;
		let m = n, hops = 0;
		while (m && m.getBoundingClientRect && hops < 5) {
			const role = (m.getAttribute && (m.getAttribute("role") || "")) || "";
			if (m.tagName === "DIALOG" || role === "dialog" || role === "alertdialog" || role === "status" || role === "alert"
				|| (m.getAttribute && (m.getAttribute("aria-modal") === "true" || m.getAttribute("aria-live")))) return true;
			const label = ((typeof m.className === "string" ? m.className : "") + " " + (m.id || ""));
			if (/(overlay|backdrop|modal|dialog|drawer|toast|snackbar|interstitial|cookie|consent|paywall)/i.test(label)) return true;
			const rr = m.getBoundingClientRect();
			const ss = getComputedStyle(m);
			if ((ss.position === "fixed" || ss.position === "sticky") && rr.width >= vw * 0.9 && rr.height >= vh * 0.5) return true;
			m = m.parentElement; hops++;
		}
		return false;
	};
	const benignOverlap = (hit, r) => {
		if (!hit || !hit.getBoundingClientRect || overlayLike(hit)) return false;
		const rh = hit.getBoundingClientRect();
		const hitArea = Math.max(1, rh.width * rh.height);
		if (hitArea > Math.max(1, r.width * r.height) * 2) return false;
		const ix = Math.max(0, Math.min(r.left + r.width, rh.left + rh.width) - Math.max(r.left, rh.left));
		const iy = Math.max(0, Math.min(r.top + r.height, rh.top + rh.height) - Math.max(r.top, rh.top));
		return (ix * iy) / hitArea >= 0.5;
	};
`;

/**
 * The whole ref resolution chain in ONE round-trip: role+name → visible text
 * (click only) → XPath → stored coords (click only). Each candidate is
 * scrolled into view, re-measured, and hit-tested with elementFromPoint; an
 * occluded candidate is recorded in `occluded` and the chain falls through
 * instead of blind-clicking. Returns {found:true, via, x, y, w, h, dpr, zoom,
 * tag, type, editable} (CSS px, viewport-relative) or {found:false, occluded}.
 * Free identifiers are limited to document / getComputedStyle /
 * devicePixelRatio / visualViewport so the contract is unit-testable against a
 * fake DOM (see in-app-actions.test.ts).
 */
export function resolutionScript(ref: DurableRef, op: "click" | "fill"): string {
	const params = JSON.stringify({
		role: ref.role,
		name: ref.name,
		xpath: ref.xpath,
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
	const finish = (el, via, px, py) => {
		// behavior:"instant" is load-bearing: with a page-level scroll-behavior:
		// smooth, scrollIntoView animates and the synchronous re-measure below
		// runs MID-FLIGHT — the hit-test lands on whatever is passing through
		// that point and every strategy false-positives as "occluded".
		if (el.scrollIntoView) el.scrollIntoView({ block: "center", inline: "center", behavior: "instant" });
		const r = el.getBoundingClientRect();
		const x = typeof px === "number" ? px : r.left + r.width / 2;
		const y = typeof py === "number" ? py : r.top + r.height / 2;
		const hit = document.elementFromPoint(x, y);
		const label = hit && hit.closest ? hit.closest("label") : null;
		const hitHost = hostOf(hit);
		const related = !!hit && (hit === el
			|| (el.contains && el.contains(hit))
			|| (hit.contains && hit.contains(el))
			|| (hitHost !== hit && !!hitHost && (hitHost === el
				|| (el.contains && el.contains(hitHost))
				|| (hitHost.contains && hitHost.contains(el))))
			|| (!!label && !!el.id && label.getAttribute("for") === el.id));
		if (!related) {
			if (p.op === "click" && benignOverlap(hit, r)) {
				const e2 = env();
				return { found: true, via, x, y, w: r.width, h: r.height, dpr: e2.dpr, zoom: e2.zoom,
					tag: el.tagName || "",
					type: ((el.getAttribute && el.getAttribute("type")) || "").toLowerCase(),
					editable: el.isContentEditable === true,
					through: describe(hit) };
			}
			occluded.push(via + ":" + describe(hit));
			return null;
		}
		const e = env();
		return { found: true, via, x, y, w: r.width, h: r.height, dpr: e.dpr, zoom: e.zoom,
			tag: el.tagName || "",
			type: ((el.getAttribute && el.getAttribute("type")) || "").toLowerCase(),
			editable: el.isContentEditable === true };
	};
	if (p.role && p.name && ROLE_SEL[p.role]) {
		for (const el of document.querySelectorAll(ROLE_SEL[p.role])) {
			if (!vis(el) || !acc(el).includes(lname)) continue;
			const hit = finish(el, "role");
			if (hit) return hit;
			break;
		}
	}
	if (p.op === "click" && p.name) {
		for (const el of document.querySelectorAll("a,button,[role],label,summary,span,div,li,td,th")) {
			if (!vis(el)) continue;
			if (!(el.textContent || "").toLowerCase().includes(lname)) continue;
			let inner = false;
			for (const c of el.children) if ((c.textContent || "").toLowerCase().includes(lname)) { inner = true; break; }
			if (inner) continue;
			const hit = finish(el, "text");
			if (hit) return hit;
			break;
		}
	}
	if (p.xpath) {
		try {
			const el = document.evaluate(p.xpath, document, null, 9, null).singleNodeValue;
			if (el && vis(el)) {
				const hit = finish(el, "xpath");
				if (hit) return hit;
			}
		} catch { /* stale xpath */ }
	}
	if (p.op === "click" && p.cw > 0 && p.ch > 0) {
		const el = document.elementFromPoint(p.cx, p.cy);
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

/** clickByText search: clickable elements first (exact matches preferred),
 *  then any innermost visible element containing the text. Occluded
 *  candidates are skipped, never blind-clicked. */
export function textSearchScript(text: string): string {
	return `(() => {
	const q = ${JSON.stringify(text)}.toLowerCase();
${OCCLUSION_HELPERS}
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
	for (const el of document.querySelectorAll(CLICKABLE)) {
		if (!vis(el)) continue;
		const t = leafText(el);
		if (!t.includes(q)) continue;
		picks.push([t === q ? 5 : 2, el]);
	}
	if (picks.length === 0) {
		for (const el of document.querySelectorAll("*")) {
			if (!vis(el)) continue;
			const t = leafText(el);
			if (!t.includes(q)) continue;
			let inner = false;
			for (const c of el.children) if ((c.textContent || "").toLowerCase().includes(q)) { inner = true; break; }
			if (!inner) picks.push([t === q ? 3 : 0, el]);
		}
	}
	picks.sort((a, b) => b[0] - a[0]);
	// On a tie at the top score the DOM order carries no signal — prefer a
	// candidate already in the viewport so the click is predictable, and warn
	// the model the match was ambiguous so it can disambiguate with a ref.
	const top = picks.length ? picks[0][0] : -1;
	const tied = picks.filter((pk) => pk[0] === top).length;
	const inVp = (e) => { const r = e.getBoundingClientRect(); const vw = document.documentElement.clientWidth || 1; const vh = document.documentElement.clientHeight || 1; return r.bottom > 0 && r.right > 0 && r.top < vh && r.left < vw; };
	if (tied > 1) picks.sort((a, b) => (b[0] - a[0]) || ((inVp(b[1]) ? 1 : 0) - (inVp(a[1]) ? 1 : 0)));
	for (const pick of picks) {
		const el = pick[1];
		// instant: a smooth-scrolling page would animate past the synchronous
		// re-measure below (same hazard as resolutionScript's finish()).
		if (el.scrollIntoView) el.scrollIntoView({ block: "center", inline: "center", behavior: "instant" });
		const r = el.getBoundingClientRect();
		const x = r.left + r.width / 2, y = r.top + r.height / 2;
		const hit = document.elementFromPoint(x, y);
		const related = !!hit && (hit === el || (el.contains && el.contains(hit)) || (hit.contains && hit.contains(el)));
		if (!related && !benignOverlap(hit, r)) continue;
		const res = { found: true, role: roleOf(el), x, y,
			dpr: (typeof devicePixelRatio === "number" && devicePixelRatio) || 1,
			zoom: (typeof visualViewport !== "undefined" && visualViewport && visualViewport.scale) || 1 };
		if (tied > 1) res.note = 'matched ' + tied + ' elements for "' + ${JSON.stringify(text)} + '", clicked the first visible — use a ref to target a specific one';
		return res;
	}
	return { found: false };
})()`;
}

/** <select> fill: CDP parity — never typed; .value + input/change events. */
export function selectFillScript(ref: DurableRef, value: string): string {
	const params = JSON.stringify({ xpath: ref.xpath, name: ref.name, value });
	return `(() => {
	const p = ${params};
	let el = null;
	if (p.xpath) { try { el = document.evaluate(p.xpath, document, null, 9, null).singleNodeValue; } catch { /* stale */ } }
	if (!el || el.tagName !== "SELECT") {
		const lname = (p.name || "").toLowerCase();
		for (const c of document.querySelectorAll("select")) {
			const acc = (((c.getAttribute("aria-label") || "") + " " + (c.name || "") + " " + (c.id || ""))).toLowerCase();
			if (!lname || acc.includes(lname)) { el = c; break; }
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
