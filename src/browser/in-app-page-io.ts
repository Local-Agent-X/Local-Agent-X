/**
 * In-app page I/O — the viewId-keyed desktop-bridge reads behind
 * ElectronInAppBackend that touch no tab/observation state: screenshot
 * capture (with the KB1 credential-focus gate), the console/network
 * perception rings (chunk E), and the beforeunload dialog queue (chunk F).
 *
 * Kept out of the backend for the LOC cap; the backend stays the owner of
 * lifecycle (ensureView / isActive) and calls these with the ACTIVE tab's
 * viewId. Everything here is a stateless passthrough over bridge-client.ts,
 * formatted by the same modules the CDP backend uses (bridge-perception.ts,
 * page-ops.ts) so both backends keep identical result shapes.
 */

import type { Page } from "playwright";
import { browserDialogs, browserExec, browserReadConsole, browserReadNetwork } from "./bridge-client.js";
import { formatConsoleReport, formatNetworkReport } from "./bridge-perception.js";
import { screenshotAsBase64 } from "./page-ops.js";
import { CREDENTIAL_CAPTURE_BLOCKED } from "./in-app-actions.js";

/** The engine label surfaced in getInfo/screenshot output. */
export const IN_APP_ENGINE = "electron";

/**
 * KB1 credential-focus probe (isolated world) — captureScreenshot's sole gate.
 * Walks the focus chain through same-origin iframes AND open shadow roots
 * (activeElement retargets to the shadow host). Fails CLOSED: a focused
 * CROSS-ORIGIN iframe (contentDocument null/throws) is unreadable but
 * focus-is-inside-it IS observable — the canonical embedded bank/Stripe/
 * OAuth login — so we block (CREDENTIAL_CAPTURE_BLOCKED names the reason).
 * Closed shadow roots are the residual gap.
 */
export const CREDENTIAL_FOCUS_SCRIPT = `(() => {
	let el = document.activeElement;
	for (let i = 0; i < 16 && el; i++) {
		if (el.tagName === "IFRAME") {
			let doc = null;
			try { doc = el.contentDocument; } catch { return true; }
			if (!doc) return true;
			el = doc.activeElement;
			continue;
		}
		if (el.shadowRoot && el.shadowRoot.activeElement) {
			el = el.shadowRoot.activeElement;
			continue;
		}
		break;
	}
	if (!el || el.tagName !== "INPUT" || !el.getAttribute) return false;
	const type = (el.getAttribute("type") || "").toLowerCase();
	const ac = (el.getAttribute("autocomplete") || "").toLowerCase();
	return type === "password" || ac === "current-password" || ac === "new-password";
})()`;

/** Honest no-pending answer: only beforeunload is interceptable here, so a
 *  visible popup is NATIVE and belongs to the co-driving user. */
export const IN_APP_NO_DIALOG =
	"No native dialog pending. Note: the in-app browser can only intercept beforeunload " +
	"dialogs — alert/confirm/prompt render natively to the user co-driving the window; " +
	"if a popup is visible, ask the user to handle it.";

// ── Screenshot (KB1-gated) ──

/** KB1 (plan invariant S1-5): never paint pixels while a credential field is
 *  focused in the co-driven view — the user may be mid-password. Probe the
 *  isolated world FIRST; if blocked, do NOT reach browserCapture. */
export async function captureScreenshotInApp(viewId: string, page: Page): Promise<string> {
	const credentialFocused = await browserExec(viewId, CREDENTIAL_FOCUS_SCRIPT);
	if (credentialFocused === true) return CREDENTIAL_CAPTURE_BLOCKED;
	return screenshotAsBase64(page, IN_APP_ENGINE);
}

// ── Perception (desktop console/network rings) ──

export async function readConsoleInApp(viewId: string): Promise<string> {
	return formatConsoleReport(await browserReadConsole(viewId));
}

export async function readNetworkInApp(viewId: string): Promise<string> {
	const { entries, inFlight } = await browserReadNetwork(viewId);
	return formatNetworkReport(entries, inFlight);
}

// ── Dialogs (beforeunload queue on the desktop — browser-dialogs.ts) ──
// promptText is parity only; prompt() isn't interceptable here.

export async function acceptDialogInApp(viewId: string): Promise<string> {
	const { handled } = await browserDialogs(viewId, "accept");
	if (!handled) return IN_APP_NO_DIALOG;
	return `Accepted ${handled.type} dialog: "${handled.message.slice(0, 80)}" — the block is lifted for the NEXT unload: retry the navigation or close that was cancelled.`;
}

export async function dismissDialogInApp(viewId: string): Promise<string> {
	const { handled } = await browserDialogs(viewId, "dismiss");
	if (!handled) return IN_APP_NO_DIALOG;
	return `Dismissed ${handled.type} dialog: "${handled.message.slice(0, 80)}" — the page stays.`;
}
