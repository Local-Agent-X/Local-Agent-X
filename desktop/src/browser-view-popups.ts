/**
 * Local Agent X — Managed popups for browser views
 *
 * window.open from view content used to be denied outright, which silently
 * broke popup-mode OAuth ("Sign in with Google" → nothing happens). The deny
 * existed for two real reasons — popup children inherit the partition but not
 * the per-webContents hardening, and they'd live outside the pool as
 * unmanaged OS windows. This module keeps both invariants while letting the
 * popup open: every child window gets the view's webPreferences and WebRTC
 * hardening, the same window-open discipline recursively, and its lifetime is
 * tracked so closing the view closes its popups. Session-level guards
 * (egress, permissions, download quarantine) are carried by the partition and
 * apply to children automatically.
 */

import type { BrowserWindow, WebContents, WebPreferences } from "electron";

/** Backstop against popup storms, not a UX budget — OAuth flows use 1. */
export const MAX_POPUPS_PER_VIEW = 5;

export interface PopupDeps {
	/** webPreferences for a child window — the view's own, same partition. */
	webPreferences: () => WebPreferences;
	/** Per-webContents hardening (WebRTC policy) the partition can't carry. */
	harden: (wc: WebContents) => void;
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
		contents.setWindowOpenHandler(() => {
			if (popups.size >= MAX_POPUPS_PER_VIEW) return { action: "deny" };
			return {
				action: "allow",
				overrideBrowserWindowOptions: {
					autoHideMenuBar: true,
					webPreferences: deps.webPreferences(),
				},
			};
		});
		contents.on("did-create-window", (child) => {
			popups.add(child);
			deps.harden(child.webContents);
			adopt(child.webContents);
			child.once("closed", () => popups.delete(child));
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
