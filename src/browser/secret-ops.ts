// The page access the secret tools need — the one seam where plaintext touches
// a live page.
//
// secret-fill / secret-capture used to take a concrete BrowserManager and drive
// its Playwright `Page` directly, which is why they were CDP-only: an in-app
// WebContentsView has no Page. That coupling was never about CDP being special;
// the tools need five narrow abilities, all of which both backends can do.
//
// Why not just call BrowserBackend.fill()/evaluate()? Because that contract is
// built to RETURN PAGE CONTENT to the model, and every part of it is wrong for a
// secret:
//   - fill() echoes the value back in its own error ("expected 'hunter2' got …")
//   - fill() returns the read-back `actual` across the process boundary
//   - evaluate() formats a result string for the LLM
// A secret must never make any of those trips. So the outcome type here carries
// NO value — there is no field to leak one through — and the fill verdict is
// computed inside the page, so the plaintext is never sent back over the bridge
// at all. That is strictly tighter than the CDP readback it replaces, which
// pulled the value back into Node to compare it.

import type { Page } from "playwright";
import { browserExec, browserInput } from "./bridge-client.js";

/** What the target element actually is — read server-side, never from the LLM. */
export interface SecretElementDescriptor {
	found: boolean;
	tag: string;
	type: string;
	autocomplete: string;
}

/**
 * Result of writing a secret into a field. Deliberately value-free: callers
 * can act on the verdict but cannot echo, log, or return the plaintext,
 * because it isn't here.
 */
export type SecretFillOutcome =
	| { kind: "landed" }
	/** Wrote, but the field reads back "" (password/hidden) — can't confirm. */
	| { kind: "masked-unverifiable" }
	/** Wrote, and the field disagrees. Values withheld on purpose. */
	| { kind: "mismatch" }
	| { kind: "not-found" }
	| { kind: "not-fillable" };

/** One of these is set; mirrors the capture tool's three strategies. */
export interface SecretReadTarget {
	selector?: string;
	textSelector?: string;
	attributeSelector?: string;
	attribute?: string;
}

export interface SecretBrowserOps {
	/** Origin of the live page, "" when there isn't one. */
	currentOrigin(): Promise<string>;
	describeElement(selector: string): Promise<SecretElementDescriptor>;
	/** Raw plaintext out of the page, or null when the element is missing. */
	readValue(target: SecretReadTarget): Promise<string | null>;
	fillValue(selector: string, value: string): Promise<SecretFillOutcome>;
	pressEnter(selector: string): Promise<void>;
}

// ── Page scripts, shared by both backends ──
// Identical DOM code either way: CDP hands it to page.evaluate, the in-app path
// hands it to browserExec for the view's isolated world.

export function describeElementScript(selector: string): string {
	return `(function(sel){
	var el = document.querySelector(sel);
	if (!el) return { found: false, tag: '', type: '', autocomplete: '' };
	return {
		found: true,
		tag: (el.tagName || '').toLowerCase(),
		type: (el.getAttribute('type') || '').toLowerCase(),
		autocomplete: (el.getAttribute('autocomplete') || '').toLowerCase(),
	};
})(${JSON.stringify(selector)})`;
}

export function readValueScript(target: SecretReadTarget): string {
	const args = JSON.stringify({
		sel: target.selector || null,
		textSel: target.textSelector || null,
		attrSel: target.attributeSelector || null,
		attr: target.attribute || null,
	});
	return `(function(a){
	var s = a.sel || a.textSel || a.attrSel;
	var el = document.querySelector(s);
	if (!el) return null;
	if (a.sel) {
		if (el.value !== undefined && el.value !== null) return String(el.value);
		return el.textContent || '';
	}
	if (a.textSel) return el.textContent || '';
	if (a.attrSel && a.attr) return el.getAttribute(a.attr) || '';
	return null;
})(${args})`;
}

/**
 * Writes the value and decides the verdict IN THE PAGE, returning only the
 * verdict. The plaintext goes in and never comes back — no readback crosses the
 * process boundary, so nothing downstream can accidentally surface it.
 */
export function fillSecretScript(selector: string, value: string): string {
	const sel = JSON.stringify(selector);
	const val = JSON.stringify(value);
	return `(function(){
	var el = document.querySelector(${sel});
	if (!el) return { kind: "not-found" };
	if (!("value" in el)) return { kind: "not-fillable" };
	var type = ((el.getAttribute && el.getAttribute("type")) || "").toLowerCase();
	try { el.focus(); } catch (e) {}
	// React (>=16) tracks the value on the element instance, so a plain
	// el.value assignment gets deduped by its value tracker and onChange never
	// fires — the field looks filled but the framework state stays empty. Write
	// through the prototype's native setter to defeat the tracker.
	var proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype
		: el instanceof HTMLInputElement ? HTMLInputElement.prototype
		: null;
	var desc = proto && Object.getOwnPropertyDescriptor(proto, "value");
	if (desc && desc.set) { desc.set.call(el, ${val}); } else { el.value = ${val}; }
	el.dispatchEvent(new Event("input", { bubbles: true }));
	el.dispatchEvent(new Event("change", { bubbles: true }));
	if (el.value === ${val}) return { kind: "landed" };
	if (el.value === "" && (type === "password" || type === "hidden")) return { kind: "masked-unverifiable" };
	return { kind: "mismatch" };
})()`;
}

const FILL_OUTCOMES = new Set(["landed", "masked-unverifiable", "mismatch", "not-found", "not-fillable"]);

/** Trust nothing coming back from a page. An unrecognized shape is a mismatch
 *  (the fail-closed direction: the caller reports "did not land"). */
export function asFillOutcome(raw: unknown): SecretFillOutcome {
	const kind = (raw as { kind?: unknown } | null)?.kind;
	if (typeof kind === "string" && FILL_OUTCOMES.has(kind)) return { kind } as SecretFillOutcome;
	return { kind: "mismatch" };
}

export function asElementDescriptor(raw: unknown): SecretElementDescriptor {
	const r = (raw ?? {}) as Partial<SecretElementDescriptor>;
	return {
		found: Boolean(r.found),
		tag: String(r.tag ?? ""),
		type: String(r.type ?? ""),
		autocomplete: String(r.autocomplete ?? ""),
	};
}

function originOf(url: string): string {
	try { return new URL(url).origin; } catch { return ""; }
}

// ── CDP backend ──

export function createCdpSecretOps(getPage: () => Promise<Page>): SecretBrowserOps {
	return {
		async currentOrigin() {
			return originOf((await getPage()).url());
		},
		async describeElement(selector) {
			return asElementDescriptor(await (await getPage()).evaluate(describeElementScript(selector)));
		},
		async readValue(target) {
			const raw = await (await getPage()).evaluate(readValueScript(target));
			return typeof raw === "string" ? raw : null;
		},
		async fillValue(selector, value) {
			// Runs the same in-page verdict script as the in-app path rather than
			// page.fill + inputValue: one behavior to reason about, and the value
			// stops at the page boundary instead of being pulled back to compare.
			return asFillOutcome(await (await getPage()).evaluate(fillSecretScript(selector, value)));
		},
		async pressEnter(selector) {
			await (await getPage()).locator(selector).press("Enter");
		},
	};
}

// ── In-app backend ──

export interface InAppSecretDeps {
	viewId: string;
	/** Mount the view if it isn't already — the backend's lazy create. */
	ensureView: () => Promise<void>;
}

export function createInAppSecretOps(deps: InAppSecretDeps): SecretBrowserOps {
	const exec = async (script: string): Promise<unknown> => {
		await deps.ensureView();
		return browserExec(deps.viewId, script);
	};
	return {
		async currentOrigin() {
			const raw = await exec("location.href");
			return typeof raw === "string" ? originOf(raw) : "";
		},
		async describeElement(selector) {
			return asElementDescriptor(await exec(describeElementScript(selector)));
		},
		async readValue(target) {
			const raw = await exec(readValueScript(target));
			return typeof raw === "string" ? raw : null;
		},
		async fillValue(selector, value) {
			return asFillOutcome(await exec(fillSecretScript(selector, value)));
		},
		async pressEnter(selector) {
			// Real key events, not a synthetic KeyboardEvent: login forms routinely
			// gate submit on a trusted keypress, and an isolated-world dispatch
			// carries isTrusted=false. fillSecretScript already focused the field;
			// re-focus so a stray click between the two calls can't send Enter
			// somewhere else.
			await exec(`(function(){ var el = document.querySelector(${JSON.stringify(selector)}); if (el && el.focus) el.focus(); })()`);
			await deps.ensureView();
			await browserInput(deps.viewId, { type: "keyDown", keyCode: "Enter" });
			await browserInput(deps.viewId, { type: "char", keyCode: "Enter" });
			await browserInput(deps.viewId, { type: "keyUp", keyCode: "Enter" });
		},
	};
}
