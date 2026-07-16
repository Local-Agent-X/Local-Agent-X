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

import { browserExec } from "./bridge-client.js";
import { asExecResult, clickScript, fillScript, selectScript } from "./in-app-observe.js";

export async function clickSelectorInApp(viewId: string, selector: string): Promise<void> {
	const res = asExecResult(await browserExec(viewId, clickScript(selector)));
	if (res.ok) return;
	if (res.error === "not-found") throw new Error(`Element not found: ${selector}`);
	throw new Error(`Cannot click ${selector}: ${res.error}`);
}

export async function fillSelectorInApp(viewId: string, selector: string, value: string): Promise<string> {
	const res = asExecResult(await browserExec(viewId, fillScript(selector, value)));
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
	const res = asExecResult(await browserExec(viewId, selectScript(selector, value)));
	if (!res.ok) {
		if (res.error === "not-found") throw new Error(`Element not found: ${selector}`);
		throw new Error(`Cannot select in ${selector}: ${res.error}`);
	}
	const selected = Array.isArray(res.selected) ? res.selected.map(String) : [];
	return `Selected "${selected.join(", ")}" in ${selector}`;
}
