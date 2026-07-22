/**
 * Playwright-idiom selector compatibility for the in-app backend.
 *
 * The model routinely emits Playwright-style selectors — `li:has-text("Requested
 * Permissions")`, `text=Log in`, `a >> text=Billing`, `:visible` — because the
 * CDP backend (real Playwright) accepts them. The in-app backend runs native
 * `querySelector`, which throws SyntaxError on every one of them (observed live
 * on the Clover dashboard, 2026-07-22). Instead of throwing, COMPILE the
 * selector host-side into a small JSON plan and interpret it in the page:
 *   - `text=foo` stages (unquoted: case-insensitive substring; quoted: exact),
 *   - `:has-text("x")` / `:text("x")` (substring) / `:text-is("x")` (exact)
 *     compound filters, staged across descendant/child combinators,
 *   - `:visible` filters,
 *   - `>>` chains (each part queried within the previous part's matches).
 * Plain CSS with none of these compiles to a verbatim pass-through, preserving
 * exact native semantics (commas, exotic pseudos) — zero behavior change there.
 *
 * The interpreter's free identifiers are limited to document / getComputedStyle
 * (the in-app isolated-world discipline) so it stays unit-testable against a
 * fake DOM. A selector the browser still rejects comes back as {bad: <message>}
 * rather than an in-page throw — callers surface a typed error, not Electron's
 * generic script failure.
 */

export interface TextFilter {
	text: string;
	/** true → trimmed exact match; false → case-insensitive substring. */
	exact: boolean;
}

export interface CssSegment {
	css: string;
	/** true when this segment follows a `>` (child) combinator. */
	child: boolean;
	filters: TextFilter[];
	visible: boolean;
}

export type SelectorStage =
	| { kind: "text"; text: string; exact: boolean }
	| { kind: "css"; segments: CssSegment[] };

export interface CompiledSelector {
	stages: SelectorStage[];
	/** true when any Playwright idiom was translated (diagnostics only). */
	compat: boolean;
}

/** Split a selector at top-level `>>` (never inside quotes/brackets/parens). */
function splitChain(sel: string): string[] {
	const parts: string[] = [];
	let depth = 0;
	let quote = "";
	let start = 0;
	for (let i = 0; i < sel.length; i++) {
		const c = sel[i];
		if (quote) {
			if (c === quote && sel[i - 1] !== "\\") quote = "";
			continue;
		}
		if (c === '"' || c === "'") quote = c;
		else if (c === "(" || c === "[") depth++;
		else if (c === ")" || c === "]") depth = Math.max(0, depth - 1);
		else if (c === ">" && sel[i + 1] === ">" && depth === 0) {
			parts.push(sel.slice(start, i));
			start = i + 2;
			i++;
		}
	}
	parts.push(sel.slice(start));
	return parts.map((p) => p.trim()).filter((p) => p.length > 0);
}

/** Split one css part into compounds at top-level whitespace / `>`.
 *  Returns null when `+`/`~`/`,` appear at top level — those can't be walked
 *  as stages (caller falls back to filter-the-final-matches). */
function splitCompounds(css: string): Array<{ css: string; child: boolean }> | null {
	const segs: Array<{ css: string; child: boolean }> = [];
	let depth = 0;
	let quote = "";
	let cur = "";
	let child = false;
	const push = () => {
		if (!cur.trim()) return;
		segs.push({ css: cur.trim(), child });
		cur = "";
		child = false;
	};
	for (let i = 0; i < css.length; i++) {
		const c = css[i];
		if (quote) {
			cur += c;
			if (c === quote && css[i - 1] !== "\\") quote = "";
			continue;
		}
		if (c === '"' || c === "'") { quote = c; cur += c; continue; }
		if (c === "(" || c === "[") { depth++; cur += c; continue; }
		if (c === ")" || c === "]") { depth = Math.max(0, depth - 1); cur += c; continue; }
		if (depth === 0 && /\s/.test(c)) { push(); continue; }
		if (depth === 0 && c === ">") { push(); child = true; continue; }
		if (depth === 0 && (c === "+" || c === "~" || c === ",")) return null;
		cur += c;
	}
	push();
	return segs.length > 0 ? segs : null;
}

const TEXT_PSEUDO_RE =
	/:(has-text|text-is|text)\((?:\s*"((?:[^"\\]|\\.)*)"\s*|\s*'((?:[^'\\]|\\.)*)'\s*|([^)]*))\)/;

const HAS_IDIOM_RE = /:(?:has-text|text-is|text)\(|:visible\b/;

/** Strip Playwright text/visibility pseudos out of a compound, collecting
 *  them as filters; the css remainder stays native-queryable. */
function extractPseudos(compound: string): { css: string; filters: TextFilter[]; visible: boolean } {
	let css = compound;
	const filters: TextFilter[] = [];
	for (;;) {
		const m = TEXT_PSEUDO_RE.exec(css);
		if (!m) break;
		const arg = (m[2] ?? m[3] ?? m[4] ?? "").replace(/\\(["'])/g, "$1").trim();
		filters.push({ text: arg, exact: m[1] === "text-is" });
		css = css.slice(0, m.index) + css.slice(m.index + m[0].length);
	}
	let visible = false;
	if (/:visible\b/.test(css)) {
		visible = true;
		css = css.replace(/:visible\b/g, "");
	}
	css = css.trim();
	return { css: css || "*", filters, visible };
}

export function compileSelector(selector: string): CompiledSelector {
	const raw = selector.trim();
	const parts = splitChain(raw);
	const stages: SelectorStage[] = [];
	let compat = parts.length > 1;
	for (const part of parts) {
		const textStage = /^text\s*=\s*([\s\S]*)$/.exec(part);
		if (textStage) {
			compat = true;
			const t = textStage[1].trim();
			const q = /^"([\s\S]*)"$/.exec(t) ?? /^'([\s\S]*)'$/.exec(t);
			stages.push({ kind: "text", text: q ? q[1] : t, exact: q !== null });
			continue;
		}
		if (!HAS_IDIOM_RE.test(part)) {
			stages.push({ kind: "css", segments: [{ css: part, child: false, filters: [], visible: false }] });
			continue;
		}
		compat = true;
		const compounds = splitCompounds(part);
		if (!compounds) {
			// Sibling/comma combinators alongside text pseudos: strip the pseudos
			// and apply every filter to the final match set (best effort).
			const flat = extractPseudos(part);
			stages.push({ kind: "css", segments: [{ ...flat, child: false }] });
			continue;
		}
		stages.push({
			kind: "css",
			segments: compounds.map((c) => ({ ...extractPseudos(c.css), child: c.child })),
		});
	}
	if (stages.length === 0) {
		stages.push({ kind: "css", segments: [{ css: raw || "*", child: false, filters: [], visible: false }] });
	}
	return { stages, compat };
}

/**
 * In-page interpreter for a CompiledSelector plan. Evaluates to the first
 * matching Element (visible matches preferred), null on no match, or
 * {bad: <message>} when the browser rejects the css itself. Free identifiers:
 * document / getComputedStyle only.
 */
export const SELECTOR_ENGINE_FN = `(plan) => {
	const vis = (el) => {
		if (!el || !el.getBoundingClientRect) return false;
		const r = el.getBoundingClientRect();
		if (r.width <= 0 || r.height <= 0) return false;
		const s = getComputedStyle(el);
		return s.visibility !== "hidden" && s.display !== "none";
	};
	const tmatch = (el, f) => {
		const t = ((el.textContent || "") + "").trim();
		return f.exact ? t === f.text : t.toLowerCase().indexOf(f.text.toLowerCase()) !== -1;
	};
	let ctxs = [document];
	for (const stage of plan.stages) {
		const next = [];
		if (stage.kind === "text") {
			for (const ctx of ctxs) {
				let all;
				try { all = ctx.querySelectorAll("*"); } catch (e) { return { bad: String((e && e.message) || e) }; }
				for (const el of all) {
					if (!tmatch(el, stage)) continue;
					let inner = false;
					for (const c of el.children) if (tmatch(c, stage)) { inner = true; break; }
					if (!inner && next.indexOf(el) === -1) next.push(el);
				}
			}
		} else {
			let cur = ctxs;
			for (const seg of stage.segments) {
				const segNext = [];
				for (const ctx of cur) {
					const scoped = ctx === document && !seg.child ? seg.css : (seg.child ? ":scope > " : ":scope ") + seg.css;
					let found;
					try { found = ctx.querySelectorAll(scoped); } catch (e) { return { bad: String((e && e.message) || e) }; }
					for (const el of found) {
						let ok = true;
						for (const f of seg.filters) if (!tmatch(el, f)) { ok = false; break; }
						if (ok && seg.visible && !vis(el)) ok = false;
						if (ok && segNext.indexOf(el) === -1) segNext.push(el);
					}
				}
				cur = segNext;
				if (cur.length === 0) break;
			}
			for (const el of cur) if (next.indexOf(el) === -1) next.push(el);
		}
		ctxs = next;
		if (ctxs.length === 0) return null;
	}
	for (const el of ctxs) if (vis(el)) return el;
	return ctxs[0] || null;
}`;

/** In-page expression resolving `selector` to Element | null | {bad}. */
export function selectorQuery(selector: string): string {
	return `(${SELECTOR_ENGINE_FN})(${JSON.stringify(compileSelector(selector))})`;
}

/**
 * The text the selector was aiming at, if it carried any (`text=`, `:has-text`,
 * `:text`, `:text-is`) — used to fall back to the click-by-text path when the
 * selector query itself finds nothing.
 */
export function selectorTextHint(selector: string): string | null {
	const { stages } = compileSelector(selector);
	for (let i = stages.length - 1; i >= 0; i--) {
		const s = stages[i];
		if (s.kind === "text" && s.text) return s.text;
		if (s.kind === "css") {
			for (let j = s.segments.length - 1; j >= 0; j--) {
				const filters = s.segments[j].filters;
				if (filters.length > 0 && filters[filters.length - 1].text) {
					return filters[filters.length - 1].text;
				}
			}
		}
	}
	return null;
}
