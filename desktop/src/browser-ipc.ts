/**
 * Browser IPC — renderer control of the FOREGROUND in-app browser view.
 *
 * The right-panel Browser tab (public/js/browser-tab.js) reserves space in
 * the DOM; the page itself is a WebContentsView from the browser-views pool,
 * drawn by main as an OS-level overlay. These handlers translate the
 * renderer's rect/visibility reports and nav commands onto that pool, and
 * push nav-state back so the address bar mirrors the real webContents.
 *
 * This chunk operates on a single lazily-created "foreground" view on the
 * default profile partition; per-profile/per-session views arrive with the
 * profile store phases.
 */

import { ipcMain, type IpcMainInvokeEvent, type Rectangle, type WebContents, type WebContentsView } from "electron";

import { getMainWindow } from "./window";
import {
	createBrowserView,
	getBrowserView,
	hideBrowserView,
	setBrowserViewBounds,
	showBrowserView,
} from "./browser-views";

const FOREGROUND_ID = "foreground";
const FOREGROUND_PARTITION = "persist:lax-profile-default";

interface BrowserNavState {
	url: string;
	title: string;
	canGoBack: boolean;
	canGoForward: boolean;
	loading: boolean;
}

const EMPTY_NAV_STATE: BrowserNavState = {
	url: "",
	title: "",
	canGoBack: false,
	canGoForward: false,
	loading: false,
};

/**
 * CSS px (renderer) → window DIPs. getBoundingClientRect reports zoom-scaled
 * CSS px while WebContentsView.setBounds takes DIPs relative to the window
 * content — they differ by exactly the content zoom factor (Cmd/Ctrl +/-
 * routes through window.ts setMainZoom), so they match only at zoom 1.
 */
export function scaleRectToDip(rect: Rectangle, zoomFactor: number): Rectangle {
	return {
		x: Math.round(rect.x * zoomFactor),
		y: Math.round(rect.y * zoomFactor),
		width: Math.round(rect.width * zoomFactor),
		height: Math.round(rect.height * zoomFactor),
	};
}

/**
 * Only the MAIN window may drive the foreground browser view. /apps/<id>
 * child windows load the SAME preload (app-windows.ts) — without this gate
 * an app window could move/show the overlay, hijack the user's navigation,
 * and read the current url/title through browser-get-nav-state.
 */
export function isTrustedBrowserSender(sender: WebContents): boolean {
	const win = getMainWindow();
	return !!win && !win.isDestroyed() && sender === win.webContents;
}

function readNavState(wc: WebContents): BrowserNavState {
	if (wc.isDestroyed()) return { ...EMPTY_NAV_STATE };
	return {
		url: wc.getURL(),
		title: wc.getTitle(),
		canGoBack: wc.navigationHistory.canGoBack(),
		canGoForward: wc.navigationHistory.canGoForward(),
		loading: wc.isLoading(),
	};
}

function pushNavState(wc: WebContents): void {
	const win = getMainWindow();
	if (!win || win.isDestroyed()) return;
	win.webContents.send("browser-nav-state", readNavState(wc));
}

/** Lazily create the foreground view on first use and wire nav pushes once. */
function ensureForegroundView(): WebContentsView {
	let view = getBrowserView(FOREGROUND_ID);
	if (!view) {
		createBrowserView(FOREGROUND_ID, { partition: FOREGROUND_PARTITION });
		view = getBrowserView(FOREGROUND_ID)!;
		const wc = view.webContents;
		const push = () => pushNavState(wc);
		wc.on("did-navigate", push);
		wc.on("did-navigate-in-page", push);
		wc.on("page-title-updated", push);
		wc.on("did-start-loading", push);
		wc.on("did-stop-loading", push);
	}
	return view;
}

export function setupBrowserIPC(): void {
	ipcMain.handle("browser-set-bounds", (event: IpcMainInvokeEvent, rect: Rectangle) => {
		if (!isTrustedBrowserSender(event.sender)) return;
		ensureForegroundView();
		const zoom = getMainWindow()?.webContents.getZoomFactor() ?? 1;
		setBrowserViewBounds(FOREGROUND_ID, scaleRectToDip(rect, zoom));
	});

	ipcMain.handle("browser-set-visible", (event: IpcMainInvokeEvent, visible: boolean) => {
		if (!isTrustedBrowserSender(event.sender)) return;
		if (visible) {
			ensureForegroundView();
			showBrowserView(FOREGROUND_ID);
		} else if (getBrowserView(FOREGROUND_ID)) {
			// Don't create a view just to hide it — hiding a non-existent
			// foreground view is a no-op, not an error.
			hideBrowserView(FOREGROUND_ID);
		}
	});

	ipcMain.handle("browser-navigate", async (event: IpcMainInvokeEvent, url: string) => {
		if (!isTrustedBrowserSender(event.sender)) return;
		const view = ensureForegroundView();
		// loadURL rejects on ERR_ABORTED (redirects, rapid re-navigation) —
		// that's normal browsing, not an error to surface. Nav-state events
		// carry the real outcome either way.
		await view.webContents.loadURL(url).catch(() => {});
	});

	ipcMain.handle("browser-go-back", (event: IpcMainInvokeEvent) => {
		if (!isTrustedBrowserSender(event.sender)) return;
		const view = getBrowserView(FOREGROUND_ID);
		if (view && view.webContents.navigationHistory.canGoBack()) {
			view.webContents.navigationHistory.goBack();
		}
	});

	ipcMain.handle("browser-go-forward", (event: IpcMainInvokeEvent) => {
		if (!isTrustedBrowserSender(event.sender)) return;
		const view = getBrowserView(FOREGROUND_ID);
		if (view && view.webContents.navigationHistory.canGoForward()) {
			view.webContents.navigationHistory.goForward();
		}
	});

	ipcMain.handle("browser-reload", (event: IpcMainInvokeEvent) => {
		if (!isTrustedBrowserSender(event.sender)) return;
		const view = getBrowserView(FOREGROUND_ID);
		if (view) view.webContents.reload();
	});

	ipcMain.handle("browser-get-nav-state", (event: IpcMainInvokeEvent): BrowserNavState | null => {
		if (!isTrustedBrowserSender(event.sender)) return null;
		const view = getBrowserView(FOREGROUND_ID);
		return view ? readNavState(view.webContents) : { ...EMPTY_NAV_STATE };
	});
}
