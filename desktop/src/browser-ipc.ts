/**
 * Browser IPC — renderer control of the in-app browser view pool.
 *
 * The right-panel Browser tab (public/js/browser-tab.js) reserves one anchor
 * region in the DOM; the page itself is a WebContentsView from the
 * browser-views pool, drawn by main as an OS-level overlay. These handlers
 * translate the renderer's rect/visibility reports and nav commands onto the
 * pool, and push nav-state back so the address bar mirrors the real webContents.
 *
 * Multi-view: the renderer's anchor drives ONE "current" view at a time
 * (currentViewId), but the pool may hold many — the renderer's own lazily
 * created foreground view PLUS the agent-driving per-(session,profile) views
 * created over the server bridge (server-bridge-browser.ts). browser-list-views
 * enumerates all of them and browser-switch-view flips which one is attached +
 * driven from the anchor; showBrowserView keeps the others live-but-detached
 * (the D1 invariant — background views keep running their in-flight ops).
 * Nav-state pushes are tagged with the viewId they describe so the renderer
 * only updates the address bar for the view it is currently showing.
 */

import { ipcMain, type IpcMainInvokeEvent, type Rectangle, type WebContents, type WebContentsView } from "electron";

import { getMainWindow } from "./window";
import {
	createBrowserView,
	getAttachedViewId,
	getBrowserView,
	hideBrowserView,
	listBrowserViews,
	setBrowserViewBounds,
	setPoolChangedListener,
	showBrowserView,
} from "./browser-views";

const FOREGROUND_ID = "foreground";
const FOREGROUND_PARTITION = "persist:lax-profile-default";
const PARTITION_PREFIX = "persist:lax-profile-";

interface BrowserNavState {
	viewId: string;
	url: string;
	title: string;
	canGoBack: boolean;
	canGoForward: boolean;
	loading: boolean;
}

interface BrowserViewListEntry {
	viewId: string;
	url: string;
	title: string;
	profileId?: string;
	attached: boolean;
	agentDriven: boolean;
}

function emptyNavState(viewId: string): BrowserNavState {
	return { viewId, url: "", title: "", canGoBack: false, canGoForward: false, loading: false };
}

// The view the renderer's anchor currently drives (bounds/visibility/nav). The
// renderer flips this with browser-switch-view; it defaults to the foreground
// view the tab lazily creates for the user.
let currentViewId = FOREGROUND_ID;
// Last anchor rect the renderer reported, already scaled to window DIPs. Re-applied
// to a view when the user switches to it so an agent-created view (default pool
// bounds) snaps to the panel geometry instead of its 800×600 origin box.
let lastBoundsDip: Rectangle | null = null;
// Nav-state pushes are wired once per webContents (survives viewId reuse: a
// closed+recreated view gets a fresh webContents and re-wires).
const navWired = new WeakSet<WebContents>();
// Monotonic id source for renderer-minted "new tab" views (user-1, user-2, …).
let userTabSeq = 0;
// Microtask-level debounce for the no-payload pool-change poke: a burst of
// pool mutations (create+show, close cascade) collapses into ONE re-list.
let viewsChangedQueued = false;

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
 * Only the MAIN window may drive the browser views. /apps/<id> child windows
 * load the SAME preload (app-windows.ts) — without this gate an app window could
 * move/show an overlay, hijack the user's navigation, and read url/title.
 */
export function isTrustedBrowserSender(sender: WebContents): boolean {
	const win = getMainWindow();
	return !!win && !win.isDestroyed() && sender === win.webContents;
}

/** `persist:lax-profile-work` → `work`; anything else → undefined. */
function profileIdFromPartition(partition: string): string | undefined {
	return partition.startsWith(PARTITION_PREFIX) ? partition.slice(PARTITION_PREFIX.length) : undefined;
}

function readNavState(viewId: string, wc: WebContents): BrowserNavState {
	if (wc.isDestroyed()) return emptyNavState(viewId);
	return {
		viewId,
		url: wc.getURL(),
		title: wc.getTitle(),
		canGoBack: wc.navigationHistory.canGoBack(),
		canGoForward: wc.navigationHistory.canGoForward(),
		loading: wc.isLoading(),
	};
}

function pushNavState(viewId: string, wc: WebContents): void {
	const win = getMainWindow();
	if (!win || win.isDestroyed()) return;
	win.webContents.send("browser-nav-state", readNavState(viewId, wc));
}

/** Wire nav-state pushes for a pooled view's webContents, once. Works for ANY
 *  pool view — the renderer's foreground view AND agent-driven views the user
 *  switches to, so the address bar tracks whichever view is being shown. */
function wireNavPushes(viewId: string, wc: WebContents): void {
	if (navWired.has(wc)) return;
	navWired.add(wc);
	const push = () => pushNavState(viewId, wc);
	wc.on("did-navigate", push);
	wc.on("did-navigate-in-page", push);
	wc.on("page-title-updated", push);
	wc.on("did-start-loading", push);
	wc.on("did-stop-loading", push);
}

/** Lazily create the renderer's foreground view on first use and wire it. */
function ensureForegroundView(): WebContentsView {
	let view = getBrowserView(FOREGROUND_ID);
	if (!view) {
		createBrowserView(FOREGROUND_ID, { partition: FOREGROUND_PARTITION, agentDriven: false });
		view = getBrowserView(FOREGROUND_ID)!;
	}
	wireNavPushes(FOREGROUND_ID, view.webContents);
	return view;
}

/** The view the renderer's anchor drives. The foreground view is created on
 *  demand; any other current view (set only by a successful switch to an
 *  existing pool view) is looked up — a vanished one falls back to foreground. */
function ensureCurrentView(): { viewId: string; view: WebContentsView } {
	if (currentViewId !== FOREGROUND_ID) {
		const view = getBrowserView(currentViewId);
		if (view) {
			wireNavPushes(currentViewId, view.webContents);
			return { viewId: currentViewId, view };
		}
		currentViewId = FOREGROUND_ID; // switched-to view was closed underneath us
	}
	return { viewId: FOREGROUND_ID, view: ensureForegroundView() };
}

/** Poke the renderer to re-list the pool ("browser-views-changed", no payload —
 *  browser-list-views stays the single source of truth). */
function sendViewsChanged(): void {
	if (viewsChangedQueued) return;
	viewsChangedQueued = true;
	queueMicrotask(() => {
		viewsChangedQueued = false;
		const win = getMainWindow();
		if (win && !win.isDestroyed()) win.webContents.send("browser-views-changed");
	});
}

/** Blank = nothing the user could be looking at: the view doesn't exist (or its
 *  webContents died), or it never left ""/about:blank. */
function currentViewIsBlank(): boolean {
	const view = getBrowserView(currentViewId);
	if (!view || view.webContents.isDestroyed()) return true;
	const url = view.webContents.getURL();
	return url === "" || url === "about:blank";
}

/**
 * Auto-surface policy, called by the server bridge after a successful AGENT
 * navigate. If the anchor currently drives the foreground family (the user's
 * own foreground/profile view) and that view is effectively blank, retarget the
 * anchor to the agent's view so the user sees the agent working the moment the
 * Browser tab opens. Attach only when something was ALREADY attached — when
 * nothing is attached the user is on a non-browser tab and painting an overlay
 * would cover it; the retarget alone means the next set-visible shows it.
 * A non-blank current view is never stolen — the renderer just badges.
 */
export function autoSurfaceAgentView(viewId: string): void {
	const foregroundFamily = currentViewId === FOREGROUND_ID || currentViewId.startsWith("profile-");
	if (foregroundFamily && currentViewIsBlank()) {
		const view = getBrowserView(viewId);
		if (!view || view.webContents.isDestroyed()) return; // vanished between navigate and surface
		currentViewId = viewId;
		wireNavPushes(viewId, view.webContents);
		if (getAttachedViewId() !== null) {
			showBrowserView(viewId);
			if (lastBoundsDip) setBrowserViewBounds(viewId, lastBoundsDip);
		}
		pushNavState(viewId, view.webContents);
	}
	sendViewsChanged();
}

export function setupBrowserIPC(): void {
	// Pool membership/attachment changes → poke the renderer to re-list.
	setPoolChangedListener(sendViewsChanged);

	ipcMain.handle("browser-set-bounds", (event: IpcMainInvokeEvent, rect: Rectangle) => {
		if (!isTrustedBrowserSender(event.sender)) return;
		const { viewId } = ensureCurrentView();
		const zoom = getMainWindow()?.webContents.getZoomFactor() ?? 1;
		lastBoundsDip = scaleRectToDip(rect, zoom);
		setBrowserViewBounds(viewId, lastBoundsDip);
	});

	ipcMain.handle("browser-set-visible", (event: IpcMainInvokeEvent, visible: boolean) => {
		if (!isTrustedBrowserSender(event.sender)) return;
		if (visible) {
			const { viewId } = ensureCurrentView();
			showBrowserView(viewId);
		} else if (getBrowserView(currentViewId)) {
			// Don't create a view just to hide it — hiding a non-existent view is a
			// no-op, not an error.
			hideBrowserView(currentViewId);
		}
	});

	ipcMain.handle("browser-navigate", async (event: IpcMainInvokeEvent, url: string) => {
		if (!isTrustedBrowserSender(event.sender)) return;
		const { view } = ensureCurrentView();
		// loadURL rejects on ERR_ABORTED (redirects, rapid re-navigation) — that's
		// normal browsing, not an error to surface. Nav-state events carry the real
		// outcome either way.
		await view.webContents.loadURL(url).catch(() => {});
	});

	ipcMain.handle("browser-go-back", (event: IpcMainInvokeEvent) => {
		if (!isTrustedBrowserSender(event.sender)) return;
		const wc = getBrowserView(currentViewId)?.webContents;
		if (wc && wc.navigationHistory.canGoBack()) wc.navigationHistory.goBack();
	});

	ipcMain.handle("browser-go-forward", (event: IpcMainInvokeEvent) => {
		if (!isTrustedBrowserSender(event.sender)) return;
		const wc = getBrowserView(currentViewId)?.webContents;
		if (wc && wc.navigationHistory.canGoForward()) wc.navigationHistory.goForward();
	});

	ipcMain.handle("browser-reload", (event: IpcMainInvokeEvent) => {
		if (!isTrustedBrowserSender(event.sender)) return;
		getBrowserView(currentViewId)?.webContents.reload();
	});

	ipcMain.handle("browser-get-nav-state", (event: IpcMainInvokeEvent): BrowserNavState | null => {
		if (!isTrustedBrowserSender(event.sender)) return null;
		const view = getBrowserView(currentViewId);
		return view ? readNavState(currentViewId, view.webContents) : emptyNavState(currentViewId);
	});

	// Enumerate ALL pool views (renderer foreground + agent-driven) so the tab's
	// switcher can list every view the user might watch.
	ipcMain.handle("browser-list-views", (event: IpcMainInvokeEvent): BrowserViewListEntry[] | null => {
		if (!isTrustedBrowserSender(event.sender)) return null;
		return listBrowserViews().map((v) => ({
			viewId: v.viewId,
			url: v.url,
			title: v.title,
			profileId: profileIdFromPartition(v.partition),
			attached: v.attached,
			agentDriven: v.agentDriven,
		}));
	});

	// Flip which pool view the anchor drives + shows. The target must already
	// exist (agent views are created over the bridge; the foreground view by the
	// tab). showBrowserView detaches the previous view but keeps it LIVE, so its
	// in-flight agent ops keep running while the user watches another view.
	ipcMain.handle("browser-switch-view", (event: IpcMainInvokeEvent, viewId: string): BrowserNavState | null => {
		if (!isTrustedBrowserSender(event.sender)) return null;
		const view = viewId === FOREGROUND_ID ? ensureForegroundView() : getBrowserView(viewId);
		if (!view) return null; // vanished/never-existed — renderer re-lists and recovers
		currentViewId = viewId;
		wireNavPushes(viewId, view.webContents);
		showBrowserView(viewId);
		// Snap the newly shown view to the anchor geometry (an agent view carries
		// its own default pool bounds until now).
		if (lastBoundsDip) setBrowserViewBounds(viewId, lastBoundsDip);
		const state = readNavState(viewId, view.webContents);
		pushNavState(viewId, view.webContents); // mirror immediately for late subscribers
		return state;
	});

	// Profile manager "Log in once": open (or reuse) a foreground view on a
	// specific profile's partition and drive it from the anchor so the user can
	// sign in by hand. The default profile shares the FOREGROUND view (same
	// partition); every other profile gets its own renderer-owned foreground view
	// keyed `profile-<id>` (agentDriven:false — it is the user's, not an agent's).
	// The partition persists whatever login the user completes.
	ipcMain.handle("browser-open-profile-view", async (event: IpcMainInvokeEvent, profileId: string, url?: string): Promise<BrowserNavState | null> => {
		if (!isTrustedBrowserSender(event.sender)) return null;
		if (typeof profileId !== "string" || !profileId) return null;
		const viewId = profileId === "default" ? FOREGROUND_ID : `profile-${profileId}`;
		const partition = PARTITION_PREFIX + profileId;
		let view = getBrowserView(viewId);
		if (!view) {
			createBrowserView(viewId, { partition, agentDriven: false });
			view = getBrowserView(viewId)!;
		}
		wireNavPushes(viewId, view.webContents);
		currentViewId = viewId;
		showBrowserView(viewId);
		// Snap to the last anchor geometry (a just-created view carries the pool's
		// default 800×600 box until now).
		if (lastBoundsDip) setBrowserViewBounds(viewId, lastBoundsDip);
		const target = (typeof url === "string" && url.trim()) || "about:blank";
		await view.webContents.loadURL(target).catch(() => { /* ERR_ABORTED etc. — nav-state carries the real outcome */ });
		const state = readNavState(viewId, view.webContents);
		pushNavState(viewId, view.webContents);
		return state;
	});

	// New user tab: mint a fresh renderer-owned view (agentDriven:false) on the
	// CURRENTLY selected view's partition, so "open a tab" stays inside the
	// profile the user is looking at. Attach only if something is already
	// attached — on a non-browser tab the retarget alone is enough (the next
	// set-visible shows it).
	ipcMain.handle("browser-new-tab", async (event: IpcMainInvokeEvent, url?: string): Promise<BrowserNavState | null> => {
		if (!isTrustedBrowserSender(event.sender)) return null;
		const viewId = `user-${++userTabSeq}`;
		const partition =
			listBrowserViews().find((v) => v.viewId === currentViewId)?.partition ?? FOREGROUND_PARTITION;
		createBrowserView(viewId, { partition, agentDriven: false });
		const view = getBrowserView(viewId)!;
		wireNavPushes(viewId, view.webContents);
		currentViewId = viewId;
		if (getAttachedViewId() !== null) {
			showBrowserView(viewId);
			if (lastBoundsDip) setBrowserViewBounds(viewId, lastBoundsDip);
		}
		const target = (typeof url === "string" && url.trim()) || "about:blank";
		await view.webContents.loadURL(target).catch(() => { /* ERR_ABORTED etc. — nav-state carries the real outcome */ });
		const state = readNavState(viewId, view.webContents);
		pushNavState(viewId, view.webContents);
		return state;
	});
}
