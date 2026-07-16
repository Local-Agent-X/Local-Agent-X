/**
 * In-app browser dialog interception — the honest subset Electron allows.
 *
 * Electron 35 exposes NO main-process hook for window.alert/confirm/prompt
 * (electron.d.ts has no setJavaScriptDialogHandler or javascript-dialog
 * API) — those render natively to the co-driving user. The ONE
 * interceptable dialog is beforeunload: webContents fires
 * 'will-prevent-unload' when a page's beforeunload handler tries to block
 * an unload (electron.d.ts:16467). NOT calling event.preventDefault()
 * keeps the page (Chromium cancels the unload); calling it ignores the
 * page's handler and lets the unload proceed. So this queue mirrors the
 * CDP dialog-handler contract for the beforeunload type only:
 *   - an intercepted attempt is QUEUED and the page stays put (never
 *     silently discard a page's "unsaved changes" guard),
 *   - accept arms a ONE-SHOT allow: the next unload attempt on the view
 *     is let through via event.preventDefault() — the caller retries the
 *     navigation/close that was cancelled,
 *   - dismiss drops the queue entry; the page already stayed.
 *
 * Pure leaf (Electron types only) — unit-testable without Electron.
 * Wired per view by server-bridge-browser's lifecycle observer.
 */

import type { WebContents } from "electron";

export interface InAppDialogInfo {
	type: "beforeunload";
	message: string;
}

/** Chromium never exposes the page's custom beforeunload text (modern
 *  browsers ignore it anyway), so every queued entry carries this message. */
export const BEFOREUNLOAD_MESSAGE =
	"This page asked to confirm leaving — changes may not be saved. The unload was kept blocked.";

export const MAX_PENDING_DIALOGS = 8;

interface ViewDialogState {
	pending: InAppDialogInfo[];
	allowNextUnload: boolean;
	cleanup: () => void;
}

const stateByView = new Map<string, ViewDialogState>();

/** Wire a view's beforeunload interception (ViewLifecycleObserver.onViewCreated). */
export function attachDialogInterception(viewId: string, wc: WebContents): void {
	if (stateByView.has(viewId)) detachDialogState(viewId);
	const onWillPreventUnload = (event: { preventDefault(): void }): void => {
		const state = stateByView.get(viewId);
		if (!state) return;
		if (state.allowNextUnload) {
			// One-shot accept: ignore the page's handler — the unload proceeds.
			state.allowNextUnload = false;
			event.preventDefault();
			return;
		}
		// Default: leave the event alone → Chromium cancels the unload and the
		// page stays. Queue the interception for dialog_accept / dialog_dismiss.
		state.pending.push({ type: "beforeunload", message: BEFOREUNLOAD_MESSAGE });
		if (state.pending.length > MAX_PENDING_DIALOGS) state.pending.shift();
	};
	wc.on("will-prevent-unload", onWillPreventUnload as never);
	stateByView.set(viewId, {
		pending: [],
		allowNextUnload: false,
		cleanup: () => {
			if (wc.isDestroyed()) return;
			wc.off("will-prevent-unload", onWillPreventUnload as never);
		},
	});
}

/** Tear down a view's dialog state at close (ViewLifecycleObserver.onViewClosed). */
export function detachDialogState(viewId: string): void {
	const state = stateByView.get(viewId);
	if (!state) return;
	stateByView.delete(viewId);
	try {
		state.cleanup();
	} catch {
		/* webContents already torn down */
	}
}

/** Pending intercepted dialogs, oldest first. Unknown view → empty. */
export function listDialogs(viewId: string): InAppDialogInfo[] {
	return [...(stateByView.get(viewId)?.pending ?? [])];
}

/**
 * Handle the next queued dialog. accept arms the one-shot allow (the next
 * unload attempt on this view proceeds); dismiss just drops the entry (the
 * page already stayed). Returns null when nothing is queued.
 */
export function handleDialog(viewId: string, action: "accept" | "dismiss"): InAppDialogInfo | null {
	const state = stateByView.get(viewId);
	const next = state?.pending.shift();
	if (!state || !next) return null;
	if (action === "accept") state.allowNextUnload = true;
	return next;
}

export function _resetBrowserDialogsForTest(): void {
	for (const state of stateByView.values()) {
		try { state.cleanup(); } catch { /* test teardown */ }
	}
	stateByView.clear();
}
