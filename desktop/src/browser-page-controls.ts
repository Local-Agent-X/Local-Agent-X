/**
 * Page controls for the in-app browser pane: find-in-page + per-view zoom.
 *
 * Split out of browser-ipc.ts (which sits at the 400-LOC ceiling) and
 * registered from setupBrowserIPC. Two surfaces:
 *
 *  - Trusted-sender-gated ipcMain commands (browser-find-start/next/prev/stop,
 *    browser-set-zoom/browser-get-zoom) acting on the SELECTED view — the
 *    current viewId is injected from browser-ipc.ts at setup so the module
 *    never duplicates that state.
 *  - Per-view webContents wiring (wirePageControls): found-in-page results are
 *    PUSHED to the renderer tagged with their viewId ("browser-found-in-page",
 *    same idiom as browser-nav-state). Push, not reply: findInPage results
 *    arrive via an async event — possibly several updates per request — so a
 *    reply-based surface would have to correlate requestIds; the existing
 *    tagged-push pattern already solves exactly this. The same wiring adds a
 *    before-input-event handler so Ctrl+F / Ctrl+± / Ctrl+0 / Esc work while
 *    FOCUS IS INSIDE THE PAGE itself.
 *
 * Keyboard scoping: window.ts owns Ctrl+=/-/0 via before-input-event on the
 * MAIN window's webContents. A pooled WebContentsView is a different
 * webContents — its input never reaches the window handler and vice versa —
 * so wiring the view's own before-input-event scopes view zoom to "focus is
 * inside the page" with zero interaction with window zoom. window.ts is
 * untouched.
 *
 * Bounds-math invariant: zoom here goes ONLY through the view's own
 * webContents.setZoomFactor. The DIP conversion for setBounds
 * (browser-ipc.ts scaleRectToDip) reads the WINDOW's zoom factor via
 * getMainWindow().webContents.getZoomFactor() — a per-view zoom change never
 * feeds that conversion (regression-tested in test/browser-find.test.ts).
 */

import { ipcMain, type IpcMainInvokeEvent, type WebContents } from "electron";

import { getMainWindow } from "./window";
import { getBrowserView, listBrowserViews } from "./browser-views";

// Per-view zoom range. Wider than window.ts's window-zoom clamp (0.7–1.6,
// which exists to keep the native titlebar overlay aligned) — a page zoom has
// no such constraint, so it gets browser-typical bounds.
const VIEW_ZOOM_MIN = 0.25;
const VIEW_ZOOM_MAX = 3;
const VIEW_ZOOM_STEP = 0.1;

/**
 * Only the MAIN window may drive the browser views. /apps/<id> child windows
 * load the SAME preload (app-windows.ts) — without this gate an app window
 * could move/show an overlay, hijack the user's navigation, and read
 * url/title. (Moved here from browser-ipc.ts in the find/zoom split;
 * browser-ipc re-exports it for existing consumers.)
 */
export function isTrustedBrowserSender(sender: WebContents): boolean {
	const win = getMainWindow();
	return !!win && !win.isDestroyed() && sender === win.webContents;
}

// The view the renderer's anchor currently drives — injected from
// browser-ipc.ts (the single owner of that state) at setup.
let currentViewIdRef: () => string = () => "foreground";

// found-in-page + before-input wired once per webContents (a closed+recreated
// view gets a fresh webContents and re-wires via the pool sweep).
const controlsWired = new WeakSet<WebContents>();
// Views with an ACTIVE find session — scopes the Esc intercept so a page only
// loses its Esc key while a find is actually up.
const findActive = new WeakSet<WebContents>();
// The one live find session. Kept as a pointer (not just the WeakSet) so a
// find-stop issued AFTER a view switch still clears the session on the view
// that owns it — the command surface otherwise only reaches the current view.
let activeFind: { viewId: string; wc: WebContents } | null = null;

function selectedView(): { viewId: string; wc: WebContents } | null {
	const viewId = currentViewIdRef();
	const view = getBrowserView(viewId);
	if (!view || view.webContents.isDestroyed()) return null;
	return { viewId, wc: view.webContents };
}

function sendToRenderer(channel: string, payload: unknown): void {
	const win = getMainWindow();
	if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
}

function clampZoom(factor: number): number {
	return Math.min(VIEW_ZOOM_MAX, Math.max(VIEW_ZOOM_MIN, factor));
}

/** Apply a clamped zoom to the VIEW's webContents and mirror it to the
 *  renderer so its per-view zoom map + toolbar label stay in sync. */
function applyViewZoom(viewId: string, wc: WebContents, factor: number): void {
	const clamped = clampZoom(factor);
	wc.setZoomFactor(clamped);
	sendToRenderer("browser-zoom-changed", { viewId, factor: clamped });
}

function stopActiveFind(): void {
	if (activeFind && !activeFind.wc.isDestroyed()) {
		activeFind.wc.stopFindInPage("clearSelection");
		findActive.delete(activeFind.wc);
	}
	activeFind = null;
}

/** Begin/continue a find on the current view; a session left on another view
 *  is cleared first so its highlights don't linger off-screen. */
function findOnCurrent(query: string, opts?: Electron.FindInPageOptions): void {
	const cur = selectedView();
	if (!cur) return;
	if (activeFind && activeFind.wc !== cur.wc) stopActiveFind();
	wirePageControls(cur.viewId, cur.wc);
	activeFind = cur;
	findActive.add(cur.wc);
	cur.wc.findInPage(query, opts);
}

/** Wire found-in-page pushes + in-page keyboard handling for one view. */
export function wirePageControls(viewId: string, wc: WebContents): void {
	if (controlsWired.has(wc)) return;
	controlsWired.add(wc);
	wc.on("found-in-page", (_e, result) => {
		sendToRenderer("browser-found-in-page", {
			viewId,
			matches: result.matches,
			activeMatchOrdinal: result.activeMatchOrdinal,
			finalUpdate: result.finalUpdate,
		});
	});
	wc.on("before-input-event", (event, input) => {
		if (input.type !== "keyDown") return;
		const mod = input.control || input.meta;
		if (mod && (input.key === "=" || input.key === "+")) {
			event.preventDefault();
			applyViewZoom(viewId, wc, wc.getZoomFactor() + VIEW_ZOOM_STEP);
		} else if (mod && (input.key === "-" || input.key === "_")) {
			event.preventDefault();
			applyViewZoom(viewId, wc, wc.getZoomFactor() - VIEW_ZOOM_STEP);
		} else if (mod && input.key === "0") {
			event.preventDefault();
			applyViewZoom(viewId, wc, 1);
		} else if (mod && !input.shift && input.key.toLowerCase() === "f") {
			// Ctrl+Shift+F is the app's global search (chat-extras.js) — only
			// bare Ctrl/Cmd+F opens the page find bar.
			// Focus must move to the renderer first or the find bar's input
			// can't take keystrokes (the native view keeps OS-level focus).
			event.preventDefault();
			getMainWindow()?.webContents.focus();
			sendToRenderer("browser-find-hotkey", { viewId });
		} else if (input.key === "Escape" && findActive.has(wc)) {
			// Esc is intercepted ONLY while this view has an active find —
			// otherwise pages keep their own Esc (fullscreen exit, dialogs).
			event.preventDefault();
			wc.stopFindInPage("clearSelection");
			findActive.delete(wc);
			if (activeFind && activeFind.wc === wc) activeFind = null;
			sendToRenderer("browser-find-closed", { viewId });
		}
	});
}

/** Sweep the pool and wire any not-yet-wired view. Chained onto the pool
 *  change listener in browser-ipc.ts, so views minted ANYWHERE — the
 *  renderer's foreground/user tabs AND agent views created over the server
 *  bridge — get page controls the moment they exist. */
export function wirePageControlsForPool(): void {
	for (const v of listBrowserViews()) {
		const view = getBrowserView(v.viewId);
		if (view && !view.webContents.isDestroyed()) wirePageControls(v.viewId, view.webContents);
	}
}

export function setupBrowserPageControls(getCurrentViewId: () => string): void {
	currentViewIdRef = getCurrentViewId;

	ipcMain.handle("browser-find-start", (event: IpcMainInvokeEvent, query: string) => {
		if (!isTrustedBrowserSender(event.sender)) return;
		if (typeof query !== "string" || !query) return;
		findOnCurrent(query);
	});

	// next/prev re-send the query (stateless main): Electron's findNext:true
	// continues the session with the same text, forward flag picks direction.
	ipcMain.handle("browser-find-next", (event: IpcMainInvokeEvent, query: string) => {
		if (!isTrustedBrowserSender(event.sender)) return;
		if (typeof query !== "string" || !query) return;
		findOnCurrent(query, { forward: true, findNext: true });
	});

	ipcMain.handle("browser-find-prev", (event: IpcMainInvokeEvent, query: string) => {
		if (!isTrustedBrowserSender(event.sender)) return;
		if (typeof query !== "string" || !query) return;
		findOnCurrent(query, { forward: false, findNext: true });
	});

	// Stops the ACTIVE session wherever it lives (the renderer closes the bar
	// after a view switch too, when "current" is already the new view).
	ipcMain.handle("browser-find-stop", (event: IpcMainInvokeEvent) => {
		if (!isTrustedBrowserSender(event.sender)) return;
		stopActiveFind();
	});

	ipcMain.handle("browser-set-zoom", (event: IpcMainInvokeEvent, factor: number) => {
		if (!isTrustedBrowserSender(event.sender)) return;
		if (typeof factor !== "number" || !Number.isFinite(factor)) return;
		const cur = selectedView();
		if (!cur) return;
		applyViewZoom(cur.viewId, cur.wc, factor);
	});

	ipcMain.handle("browser-get-zoom", (event: IpcMainInvokeEvent): { viewId: string; factor: number } | null => {
		if (!isTrustedBrowserSender(event.sender)) return null;
		const cur = selectedView();
		return cur ? { viewId: cur.viewId, factor: cur.wc.getZoomFactor() } : null;
	});
}
