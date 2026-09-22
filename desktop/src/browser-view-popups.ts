/**
 * Local Agent X — Managed popups for browser views
 *
 * window.open from view content used to be denied outright, which silently
 * broke popup-mode OAuth ("Sign in with Google" → nothing happens). The deny
 * existed for two real reasons — popup children inherit the partition but not
 * the per-webContents hardening, and they'd live outside the pool as
 * unmanaged OS windows. This module keeps both invariants while letting the
 * popup open: every child window gets the view's webPreferences, the same
 * window-open discipline recursively, and its lifetime is
 * tracked so closing the view closes its popups. Session-level guards
 * (egress, permissions, download quarantine) are carried by the partition and
 * apply to children automatically.
 */

import type { BrowserWindow, WebContents, WebPreferences } from "electron";

/** Backstop against popup storms, not a UX budget — OAuth flows use 1. */
export const MAX_POPUPS_PER_VIEW = 5;

/**
 * ORIGIN ONLY, never the URL. A popup-mode OAuth URL carries `code`,
 * `id_token`, `access_token` and `state` in its query or fragment; logging one
 * whole would write a live credential to disk. The origin is what makes the
 * trace readable ("it reached accounts.google.com, then came back to
 * linkedin.com") and carries no secret.
 */
export function popupOrigin(url: string): string {
	try {
		const parsed = new URL(url);
		// An opaque origin serializes to the literal string "null", which reads
		// as a bug in a log line rather than as information. `window.open()` with
		// no URL — the opener then writes into the blank document — lands here
		// every time, so it is the common case, not an edge one. The scheme is
		// what is actually worth saying, and it carries no secret either.
		return parsed.origin === "null" ? parsed.protocol : parsed.origin;
	} catch {
		return "(unparseable url)";
	}
}

/**
 * Trace a popup's lifetime, because its failures are otherwise INVISIBLE.
 *
 * Live incident 2026-09-22: a "Continue with Google" popup opened and painted
 * nothing but white, and the whole episode left not one line in
 * desktop-stdio.log — nothing recorded the window opening, what it loaded, or
 * that it closed. With no trace there was no way to tell a page Google refused
 * to serve from a page that loaded fine and failed to paint, which are
 * different bugs with different owners (see docs/known-issues.md).
 *
 * So this logs the SUCCESS path too, not just errors. `did-fail-load` alone
 * would have stayed silent for that incident — the load did not fail. A
 * "finished load" line next to a white window is the evidence that isolates it
 * to paint or to page content; its absence isolates it to the network.
 */
function traceLifecycle(contents: WebContents, openedFor: string): void {
	const say = (line: string): void => console.log(`[browser-popup] ${openedFor} — ${line}`);
	contents.on("did-navigate", (_event, url) => say(`navigated ${popupOrigin(url)}`));
	contents.on("did-finish-load", () => say("finished load"));
	contents.on("did-fail-load", (_event, errorCode, errorDescription, validatedURL, isMainFrame) => {
		// Subframe failures are routine on a sign-in page and say nothing about
		// whether the popup itself worked. -3 (ABORTED) is a redirect or a
		// deliberate cancel, which every OAuth flow does on its way through.
		if (!isMainFrame || errorCode === -3) return;
		console.error(
			`[browser-popup] ${openedFor} — load FAILED ${popupOrigin(validatedURL)}: ${errorCode} ${errorDescription}`,
		);
	});
	contents.on("render-process-gone", (_event, details) => {
		console.error(`[browser-popup] ${openedFor} — renderer gone: ${details.reason} (exit ${details.exitCode})`);
	});
	contents.on("unresponsive", () => console.error(`[browser-popup] ${openedFor} — unresponsive`));
}

export interface PopupDeps {
	/** webPreferences for a child window — the view's own, same partition. */
	webPreferences: () => WebPreferences;
}

export interface PopupTracker {
	count(): number;
	/** Close every live popup of this view (view teardown). */
	closeAll(): void;
}

/**
 * Install the managed window-open discipline on a view's webContents.
 * Children get the same discipline, so a popup's own window.open is equally
 * hardened and counted against the same cap.
 */
export function managePopups(wc: WebContents, deps: PopupDeps): PopupTracker {
	const popups = new Set<BrowserWindow>();

	const adopt = (contents: WebContents): void => {
		// The requested origin is captured HERE because it is the only place it
		// is known: by the time did-create-window fires, the child may already
		// have redirected, and a denial has no child at all to ask.
		let lastRequestedOrigin = "(unknown origin)";
		contents.setWindowOpenHandler(({ url }) => {
			lastRequestedOrigin = popupOrigin(url);
			if (popups.size >= MAX_POPUPS_PER_VIEW) {
				console.warn(`[browser-popup] ${lastRequestedOrigin} — DENIED, ${MAX_POPUPS_PER_VIEW}-popup cap reached`);
				return { action: "deny" };
			}
			return {
				action: "allow",
				overrideBrowserWindowOptions: {
					autoHideMenuBar: true,
					webPreferences: deps.webPreferences(),
				},
			};
		});
		contents.on("did-create-window", (child) => {
			const openedFor = lastRequestedOrigin;
			popups.add(child);
			console.log(`[browser-popup] ${openedFor} — opened`);
			adopt(child.webContents);
			traceLifecycle(child.webContents, openedFor);
			child.once("closed", () => {
				popups.delete(child);
				console.log(`[browser-popup] ${openedFor} — closed`);
			});
		});
	};

	adopt(wc);
	return {
		count: () => popups.size,
		closeAll: () => {
			for (const p of popups) {
				if (!p.isDestroyed()) p.close();
			}
			popups.clear();
		},
	};
}
