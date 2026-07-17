/**
 * Nav-state mirroring for the in-app browser pool.
 *
 * The renderer's address bar mirrors the REAL webContents: main wires a pooled
 * view's navigation/title/load events (once per webContents) and pushes a
 * tagged "browser-nav-state" so the tab only updates the address bar for the
 * view it is currently showing. Split out of browser-ipc.ts so the IPC handler
 * file stays focused on the renderer command surface; the load-error WeakMap and
 * the once-per-webContents guard live here with the code that owns them.
 */

import { type WebContents } from "electron";

import { getMainWindow } from "./window";

export interface BrowserNavState {
	viewId: string;
	url: string;
	title: string;
	canGoBack: boolean;
	canGoForward: boolean;
	loading: boolean;
	/** Last MAIN-frame load failure, or null. Without this the renderer's pane
	 *  sits silently white on e.g. ERR_CONNECTION_REFUSED — the view renders a
	 *  blank error document and nothing tells the user the server is down. */
	loadError: { code: number; description: string; url: string } | null;
}

export function emptyNavState(viewId: string): BrowserNavState {
	return { viewId, url: "", title: "", canGoBack: false, canGoForward: false, loading: false, loadError: null };
}

// Nav-state pushes are wired once per webContents (survives viewId reuse: a
// closed+recreated view gets a fresh webContents and re-wires).
const navWired = new WeakSet<WebContents>();
// Last main-frame load failure per webContents; cleared the moment the next
// load starts so a retry/navigation drops the error UI immediately.
const loadErrors = new WeakMap<WebContents, { code: number; description: string; url: string }>();

export function readNavState(viewId: string, wc: WebContents): BrowserNavState {
	if (wc.isDestroyed()) return emptyNavState(viewId);
	return {
		viewId,
		url: wc.getURL(),
		title: wc.getTitle(),
		canGoBack: wc.navigationHistory.canGoBack(),
		canGoForward: wc.navigationHistory.canGoForward(),
		loading: wc.isLoading(),
		loadError: loadErrors.get(wc) ?? null,
	};
}

export function pushNavState(viewId: string, wc: WebContents): void {
	const win = getMainWindow();
	if (!win || win.isDestroyed()) return;
	win.webContents.send("browser-nav-state", readNavState(viewId, wc));
}

/** Wire nav-state pushes for a pooled view's webContents, once. Works for ANY
 *  pool view — the renderer's foreground view AND agent-driven views the user
 *  switches to, so the address bar tracks whichever view is being shown. */
export function wireNavPushes(viewId: string, wc: WebContents): void {
	if (navWired.has(wc)) return;
	navWired.add(wc);
	const push = () => pushNavState(viewId, wc);
	wc.on("did-navigate", push);
	wc.on("did-navigate-in-page", push);
	wc.on("page-title-updated", push);
	// A fresh load attempt clears any recorded failure BEFORE the push, so the
	// renderer drops its error card the moment a retry/navigation starts.
	wc.on("did-start-loading", () => { loadErrors.delete(wc); push(); });
	wc.on("did-stop-loading", push);
	// Main-frame load failures surface in nav-state; the view itself renders a
	// blank error document, so this is the only signal the renderer gets.
	// -3 = ERR_ABORTED (redirects, rapid re-navigation) is normal browsing.
	wc.on("did-fail-load", (_e, errorCode, errorDescription, validatedURL, isMainFrame) => {
		if (!isMainFrame || errorCode === -3) return;
		loadErrors.set(wc, { code: errorCode, description: errorDescription, url: validatedURL });
		push();
	});
}
