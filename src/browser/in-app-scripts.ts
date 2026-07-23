/**
 * Isolated-world page scripts for the in-app backend — pure STRING BUILDERS,
 * split from in-app-observe.ts for the 400-LOC gate:
 *   - checkedScript: the error-surfacing wrapper (execChecked in
 *     in-app-observe.ts pairs it with browserExec),
 *   - A1 selector scripts (click/fill/select).
 * The A2 resolution chain (resolutionScript / textSearchScript /
 * selectFillScript) lives in in-app-resolve-scripts.ts (same 400-LOC gate).
 *
 * Every script runs ONLY in the view's isolated world (1901, enforced in
 * desktop/src/server-bridge-browser.ts). Free identifiers are limited to
 * document / getComputedStyle / devicePixelRatio / visualViewport so the
 * contracts stay unit-testable against a fake DOM (in-app-observe.test.ts).
 */

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
