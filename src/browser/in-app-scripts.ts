/**
 * Isolated-world page scripts for the in-app backend — pure STRING BUILDERS,
 * split from in-app-observe.ts for the 400-LOC gate:
 *   - checkedScript: the wrapper that makes a script's return value safe to
 *     cross the bridge — BOTH error-surfacing AND structured-clone-safety
 *     (execChecked in in-app-observe.ts pairs it with browserExec),
 *   - A1 selector scripts (click/fill/select).
 * The A2 resolution chain (resolutionScript / textSearchScript /
 * selectFillScript) lives in in-app-resolve-scripts.ts (same 400-LOC gate).
 *
 * Every script runs ONLY in the view's isolated world (1901, enforced in
 * desktop/src/server-bridge-browser.ts). Free identifiers are limited to
 * document / getComputedStyle / devicePixelRatio / visualViewport — plus, in
 * the clone-safety helper below, the built-ins Object / Array / String / Map /
 * Set / Date / RegExp / globalThis, each behind a `typeof` guard where its
 * absence would break the fake-DOM contract tests (in-app-observe.test.ts).
 */

import { selectorQuery } from "./selector-compat.js";
import { nativeValueSetStmt, selectOptionMatchExpr } from "./in-app-script-helpers.js";

/**
 * In-page clone-safety sanitizer — JS SOURCE TEXT spliced into checkedScript
 * (this module is a string builder; there is no TS function here to call).
 *
 * Electron structured-clones an isolated-world script's RETURN VALUE out of the
 * renderer (executeJavaScriptInIsolatedWorld, desktop/src/server-bridge-
 * browser.ts). A DOM element, a function, a Window — anything the algorithm
 * can't clone — rejects the WHOLE call with "An object could not be cloned",
 * which reached the agent as an opaque browser failure with nothing to act on.
 * So the value is rebuilt out of clone-safe parts, describing what it couldn't
 * carry instead of failing the action.
 */
const CLONE_SAFE_HELPER = `
	const __laxSafe = (() => {
		const DEPTH_CAP = 6, ARR_CAP = 200, KEY_CAP = 100, DESC_CAP = 120;
		// SECURITY, load-bearing: an element descriptor is built ONLY from
		// tagName, id and class. It must NEVER include the element's value,
		// textContent, innerText, innerHTML, or ANY other attribute — turning a
		// clone crash into a way to read a password field's value would defeat
		// the read-into-model-context blocklist in guards.ts
		// (BLOCKED_EVAL_PATTERNS section 1), which exists precisely because a
		// script can return a secret to the model with zero network egress.
		// Do not "helpfully" add textContent here.
		const nodeDesc = (v) => {
			let d = String(v.tagName || "NODE");
			if (v.id) d += "#" + String(v.id);
			const cn = typeof v.className === "string" ? v.className.trim() : "";
			if (cn) d += "." + cn.split(/\\s+/).slice(0, 3).join(".");
			const out = "[" + d + "]";
			return out.length > DESC_CAP ? out.slice(0, DESC_CAP - 1) + "]" : out;
		};
		const walk = (v, depth, stack) => {
			if (v === null || v === undefined) return v;
			const t = typeof v;
			// Fast path: a plain result crosses the bridge byte-identical.
			if (t === "string" || t === "number" || t === "boolean" || t === "bigint") return v;
			if (t === "function") return "[Function: " + (v.name || "anonymous") + "]";
			if (t !== "object") return String(v);
			if (depth > DEPTH_CAP) return "[depth-limited]";
			// Structured clone handles cycles natively; this REBUILD does not, so
			// the ancestor stack stops the recursion. A repeated sibling
			// reference is a DAG, not a cycle, and still serializes in full.
			if (stack.indexOf(v) !== -1) return "[circular]";
			stack.push(v);
			try {
				if (Array.isArray(v)) {
					const out = [];
					const n = v.length > ARR_CAP ? ARR_CAP : v.length;
					for (let i = 0; i < n; i++) out.push(walk(v[i], depth + 1, stack));
					if (v.length > n) out.push("[... " + (v.length - n) + " more]");
					return out;
				}
				if (typeof Date !== "undefined" && v instanceof Date) return v; // clone-safe as-is
				if (typeof RegExp !== "undefined" && v instanceof RegExp) return String(v);
				if (typeof Map !== "undefined" && v instanceof Map) {
					const out = {};
					let n = 0;
					for (const pair of v) {
						if (n++ >= KEY_CAP) break;
						out[String(pair[0])] = walk(pair[1], depth + 1, stack);
					}
					return out;
				}
				if (typeof Set !== "undefined" && v instanceof Set) {
					const out = [];
					for (const item of v) {
						if (out.length >= ARR_CAP) break;
						out.push(walk(item, depth + 1, stack));
					}
					return out;
				}
				// Structural node test — never the Node/Element globals: these
				// scripts are unit-tested in Node against a fake DOM that has no
				// such globals (in-app-observe.test.ts).
				if (typeof v.nodeType === "number") return nodeDesc(v);
				if ((typeof globalThis !== "undefined" && v === globalThis) || (v.document && v.location)) return "[Window]";
				// An Error returned as a VALUE (not thrown) has own but NON-
				// enumerable message/stack, so Object.keys below would flatten it
				// to {}. NO stack on purpose: a stack carries page URLs (query
				// params included) into model context, and a genuine failure
				// already surfaces through the __laxScriptError marker.
				if (typeof Error !== "undefined" && v instanceof Error) {
					return { name: String(v.name), message: String(v.message) };
				}
				// toJSON is the serialization contract host objects already
				// publish — DOMRect (getBoundingClientRect), DOMPointReadOnly,
				// PerformanceEntry. Their data lives on PROTOTYPE getters, so
				// Object.keys sees nothing; before this wrapper existed they
				// structured-cloned fine, and degrading them to {} would make the
				// model reason from empty data instead of seeing a failure.
				// Ordered after Date (which keeps its Date identity, not its ISO
				// string) and after the node/Window checks (the security
				// descriptor always wins for anything node-like).
				if (typeof v.toJSON === "function") {
					try { return walk(v.toJSON(), depth + 1, stack); } catch { /* fall through to key walk */ }
				}
				const out = {};
				const keys = Object.keys(v);
				const n = keys.length > KEY_CAP ? KEY_CAP : keys.length;
				for (let i = 0; i < n; i++) {
					const k = keys[i];
					// A property whose getter throws (cross-origin contentDocument,
					// a hostile accessor) must cost one key, not the whole read.
					try { out[k] = walk(v[k], depth + 1, stack); } catch { out[k] = "[unreadable]"; }
				}
				// A keyless NON-plain object (exotic host class with no toJSON)
				// would serialize as a lying {}. A labelled unknown — "[object
				// DOMRect]" — beats an empty object that reads as real data. A
				// genuine {} still returns {}.
				if (keys.length === 0 && v.constructor && v.constructor !== Object) return String(v);
				return out;
			} catch {
				// Exotic host object / Proxy that throws on access.
				try { return String(v); } catch { return "[unserializable]"; }
			} finally {
				stack.pop();
			}
		};
		// The sanitizer itself must never throw: a hostile page's exotic object
		// degrades to a description, it never turns a browser read into an error.
		return (v) => { try { return walk(v, 0, []); } catch { return "[unserializable]"; } };
	})();
`;

/**
 * Wrap an expression script so its return value is ALWAYS safe to cross the
 * Electron bridge. Two guarantees, both about the same failure mode — a browser
 * action dying with nothing the agent can act on:
 *
 *  1. Error surfacing: an in-page throw comes back as a `{ __laxScriptError }`
 *     marker carrying the REAL error. Without it, Electron rejects with the
 *     generic "Script failed to execute, this normally means an error was
 *     thrown. Check the renderer console for the error." — undiagnosable from
 *     server logs, and it read to the agent as a broken site (2026-07-20,
 *     Thrive PO page).
 *  2. Clone safety: the result is rebuilt by __laxSafe out of structured-
 *     cloneable parts. A script returning a DOM element / function / Window
 *     used to fail the whole call with "An object could not be cloned"
 *     (2026-07-25, 9 occurrences in 3 sessions) — now it returns a readable
 *     descriptor like "[INPUT#email.form-control]" and the action survives.
 *
 * The `{ __laxScriptError }` markers are plain strings already and stay
 * byte-identical — execChecked keys off that exact shape.
 */
export function checkedScript(script: string): string {
	return `(() => {${CLONE_SAFE_HELPER}	try { const __r = (${script}); return (__r && typeof __r.then === "function") ? __r.then((v) => __laxSafe(v), (e) => ({ __laxScriptError: String((e && (e.stack || e.message)) || e) })) : __laxSafe(__r); } catch (e) { return { __laxScriptError: String((e && (e.stack || e.message)) || e) }; } })()`;
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
