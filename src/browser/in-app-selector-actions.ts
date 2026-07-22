/**
 * Selector-addressed interactions for the embedded WebContentsView.
 *
 * The plain CSS-selector half of the in-app interaction surface: one
 * isolated-world exec each, no resolution chain, no hit-testing. Its sibling
 * in-app-actions.ts owns the ref/text-addressed chain that dispatches REAL
 * input events; these run in the page instead, so they do NOT participate in
 * the desktop's co-drive arbitration.
 *
 * The backend keeps only the ensureView/snapshot orchestration around these.
 */

import { asExecResult, clickScript, fillScript, selectScript } from "./in-app-scripts.js";
import { execChecked } from "./in-app-observe.js";
import { clickTextInApp, type InAppActionContext } from "./in-app-actions.js";
import { selectorTextHint } from "./selector-compat.js";

export async function clickSelectorInApp(viewId: string, selector: string): Promise<void> {
	const res = asExecResult(await execChecked(viewId, clickScript(selector)));
	if (res.ok) return;
	if (res.error === "not-found") throw new Error(`Element not found: ${selector}`);
	throw new Error(`Cannot click ${selector}: ${res.error}`);
}

/**
 * Selector click with a click-by-text fallback: when the selector misses but
 * named its target text (text=, :has-text()), run the click-by-text chain
 * (scroll retries + hit-test) before failing the model back for another
 * round-trip. Returns null when the plain selector click landed (caller owns
 * its own snapshot flow), the text-path result text when the fallback fired,
 * and rethrows the original selector error when both miss.
 */
export async function clickSelectorOrTextFallback(
	viewId: string,
	selector: string,
	ctx: InAppActionContext,
): Promise<string | null> {
	try {
		await clickSelectorInApp(viewId, selector);
		return null;
	} catch (e) {
		const hint = selectorTextHint(selector);
		if (!hint) throw e;
		const result = await clickTextInApp(ctx, hint);
		if (!result.ok) throw e;
		return `${result.text}\n(selector "${selector}" resolved via visible text "${hint}")`;
	}
}

export async function fillSelectorInApp(viewId: string, selector: string, value: string): Promise<string> {
	const res = asExecResult(await execChecked(viewId, fillScript(selector, value)));
	if (!res.ok) {
		if (res.error === "not-found") throw new Error(`Element not found: ${selector}`);
		throw new Error(`Cannot fill ${selector}: ${res.error}`);
	}
	const actual = typeof res.actual === "string" ? res.actual : "";
	if (actual === value) return `Filled "${selector}" with value (${value.length} chars)`;
	if (actual === "" && res.type === "password") {
		return `Filled "${selector}" (verification skipped: masked input)`;
	}
	throw new Error(`Fill did not land: expected '${value}' got '${actual}'`);
}

export async function selectOptionInApp(viewId: string, selector: string, value: string): Promise<string> {
	const res = asExecResult(await execChecked(viewId, selectScript(selector, value)));
	if (!res.ok) {
		if (res.error === "not-found") throw new Error(`Element not found: ${selector}`);
		throw new Error(`Cannot select in ${selector}: ${res.error}`);
	}
	const selected = Array.isArray(res.selected) ? res.selected.map(String) : [];
	return `Selected "${selected.join(", ")}" in ${selector}`;
}
