/**
 * Shared string fragments for the in-app isolated-world scripts
 * (in-app-scripts.ts / in-app-resolve-scripts.ts). Extracted to keep those
 * files under the 400-LOC gate and to give the <select> option-matcher, the
 * React-safe value setter, and the occlusion/frame helpers a single home.
 * These are STRING BUILDERS — the JS they emit runs in the view's isolated
 * world, so the free-identifier discipline still applies (document /
 * getComputedStyle / …, plus HTMLInputElement / HTMLTextAreaElement, which
 * every browser realm defines).
 */

/**
 * Write a value the way React sees it. React (>=16) tracks the value on the
 * element instance, so a bare `el.value =` write is deduped by its value
 * tracker and onChange never fires — the field reads back as filled while the
 * framework's state stays empty. Writing through the prototype's native setter
 * defeats the tracker (parity with secret-ops.ts fillSecretScript). `elVar` is
 * an in-scope element variable; `valExpr` a JS expression for the new value.
 */
export function nativeValueSetStmt(elVar: string, valExpr: string): string {
	return `const __proto = ${elVar} instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype
			: ${elVar} instanceof HTMLInputElement ? HTMLInputElement.prototype : null;
		const __desc = __proto && Object.getOwnPropertyDescriptor(__proto, "value");
		if (__desc && __desc.set) __desc.set.call(${elVar}, ${valExpr}); else ${elVar}.value = ${valExpr};`;
}

/**
 * Resolve a <select> option against a target string: exact value/label/text
 * first (CDP/HTML parity), then a trimmed + case-insensitive fallback so a
 * model emitting "In Stock" still matches an "in stock" option. `optionsExpr`
 * is a JS expression for the option array; `valExpr` for the target string.
 */
export function selectOptionMatchExpr(optionsExpr: string, valExpr: string): string {
	return `((__o, __t) => __o.find((o) => o.value === __t || o.label === __t || o.text === __t)
			|| __o.find((o) => { const __v = __t.trim().toLowerCase();
				return (o.value || "").trim().toLowerCase() === __v || (o.label || "").trim().toLowerCase() === __v || (o.text || "").trim().toLowerCase() === __v; }))(${optionsExpr}, ${valExpr})`;
}

/**
 * Occlusion classification, shared by resolutionScript and textSearchScript
 * (in-app-resolve-scripts.ts). A failed hit-test does NOT always mean a
 * blocking overlay: cosmetic siblings (icons, ripple spans, styled sibling
 * elements) routinely sit on top of the target without being DOM-related —
 * and a HUMAN click lands on exactly that topmost element. Those are BENIGN:
 * dispatch the click at the point anyway. Blocking overlays (modals,
 * backdrops, toasts, full-viewport fixed layers) stay refused, so the model
 * gets the named occluder instead of a blind click. Benign requires the
 * overlapper to be small (≤2× the target's area) and to sit mostly WITHIN the
 * target's bounds — a nav bar or banner covering the point fails both and
 * stays a refusal. overlayLike sizes against the element's OWN document
 * (frame-local viewport for iframe candidates).
 */
export const OCCLUSION_HELPERS = `
	const overlayLike = (n, dd) => {
		const de = (dd || document).documentElement;
		const vw = (de && de.clientWidth) || 1;
		const vh = (de && de.clientHeight) || 1;
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
	const benignOverlap = (hit, r, dd) => {
		if (!hit || !hit.getBoundingClientRect || overlayLike(hit, dd)) return false;
		const rh = hit.getBoundingClientRect();
		const hitArea = Math.max(1, rh.width * rh.height);
		if (hitArea > Math.max(1, r.width * r.height) * 2) return false;
		const ix = Math.max(0, Math.min(r.left + r.width, rh.left + rh.width) - Math.max(r.left, rh.left));
		const iy = Math.max(0, Math.min(r.top + r.height, rh.top + rh.height) - Math.max(r.top, rh.top));
		return (ix * iy) / hitArea >= 0.5;
	};
`;

/** Same-origin frame roots + main-page offset for the resolution scripts.
 *  A root is { doc, frameEl } (frameEl null = main document); the offset is
 *  read at USE time, never cached — scrollIntoView moves the frame's rect.
 *  mainViewportMiss guards frame-derived coords: a frame candidate whose
 *  final MAIN-page point falls outside the main viewport (offscreen/clipped/
 *  hidden iframes) must be rejected, not clicked into dead air.
 *  frameCover closes the other half of that contract: the frame-local
 *  hit-test cannot see a MAIN-document layer stacked over the iframe (modal,
 *  backdrop, toast), so the final main-page point is re-hit-tested in the
 *  main document and must land on the frame element itself (or a benign
 *  cosmetic overlap, same rule as in-frame occlusion). Requires
 *  OCCLUSION_HELPERS in scope when actually invoked. Residual: an
 *  overflow:hidden ANCESTOR that clips the iframe is accepted by the
 *  hit-contains-frame arm and stays undetected — narrower than the modal
 *  class this guards against. */
export const FRAME_HELPERS = `
	const sameOriginRoots = () => {
		const out = [];
		for (const f of document.querySelectorAll("iframe, frame")) {
			try {
				if (f.contentDocument) out.push({ doc: f.contentDocument, frameEl: f, src: (f.getAttribute("src") || "") });
			} catch { /* cross-origin */ }
		}
		return out;
	};
	const frameOffset = (root) => {
		if (!root.frameEl) return { dx: 0, dy: 0 };
		const fr = root.frameEl.getBoundingClientRect();
		return { dx: fr.left, dy: fr.top };
	};
	const rootsForRef = (frameUrl) => {
		if (frameUrl === undefined || frameUrl === null) return [{ doc: document, frameEl: null }];
		const all = sameOriginRoots();
		return all.filter((r) => r.src === frameUrl).concat(all.filter((r) => r.src !== frameUrl));
	};
	const mainViewportMiss = (root, x, y) => {
		if (!root.frameEl) return false; // main-doc candidates keep pre-frame behavior
		const de = document.documentElement;
		return x < 0 || y < 0 || x >= ((de && de.clientWidth) || 1) || y >= ((de && de.clientHeight) || 1);
	};
	const frameCover = (root, mx, my, mr) => {
		if (!root.frameEl) return { ok: true }; // main-doc candidates keep their own hit-test
		const hit = document.elementFromPoint(mx, my);
		if (!hit) return { ok: true }; // nothing stacked at the point (or bare fake DOM)
		const rel = hit === root.frameEl
			|| (root.frameEl.contains && root.frameEl.contains(hit))
			|| (hit.contains && hit.contains(root.frameEl));
		if (rel || benignOverlap(hit, mr, document)) return { ok: true };
		return { ok: false, hit };
	};
`;
