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

import { ipcMain, type IpcMainInvokeEvent, type Rectangle, type WebContentsView } from "electron";

import { getMainWindow } from "./window";
import { isTrustedBrowserSender, setupBrowserPageControls, wirePageControlsForPool } from "./browser-page-controls";
// The trusted-sender guard moved to browser-page-controls.ts in the find/zoom
// split (this file sits at the 400-LOC ceiling); re-exported so existing
// consumers keep importing it from here.
export { isTrustedBrowserSender } from "./browser-page-controls";
import {
	closeBrowserView,
	createBrowserView,
	getAttachedViewId,
	getBrowserView,
	hideBrowserView,
	listBrowserViews,
	setBrowserChatOverlay,
	setBrowserViewBounds,
	setPoolChangedListener,
	showBrowserView,
} from "./browser-views";
import {
	type BrowserNavState,
	emptyNavState,
	pushNavState,
	readNavState,
	wireNavPushes,
} from "./browser-ipc-navstate";
import { emitAgentViewClosed } from "./browser-perception";
import { decideAgentSurface, isSessionAgentView } from "./browser-surface-policy";

const FOREGROUND_ID = "foreground";
const FOREGROUND_PARTITION = "persist:lax-profile-default";
const PARTITION_PREFIX = "persist:lax-profile-";

interface BrowserViewListEntry {
	viewId: string;
	url: string;
	title: string;
	profileId?: string;
	attached: boolean;
	agentDriven: boolean;
}

interface BrowserChatOverlayPayload {
	bounds: Rectangle;
	overlayUrl: string;
	sessionId: string | null;
	collapsed: boolean;
	latestOpen: boolean;
}

// The view the renderer's anchor currently drives (bounds/visibility/nav). The
// renderer flips this with browser-switch-view; it defaults to the foreground
// view the tab lazily creates for the user.
let currentViewId = FOREGROUND_ID;
// Last anchor rect the renderer reported, already scaled to window DIPs. Re-applied
// to a view when the user switches to it so an agent-created view (default pool
// bounds) snaps to the panel geometry instead of its 800×600 origin box.
let lastBoundsDip: Rectangle | null = null;
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

/** `persist:lax-profile-work` → `work`; anything else → undefined. */
function profileIdFromPartition(partition: string): string | undefined {
	return partition.startsWith(PARTITION_PREFIX) ? partition.slice(PARTITION_PREFIX.length) : undefined;
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

/** Retarget the anchor to an agent view and surface it: wire nav pushes, attach
 *  only when something is ALREADY attached (else the next set-visible shows it),
 *  snap to the anchor geometry, mirror nav-state, and raise the Browser tab.
 *  Guards a view that vanished between the trigger and here. */
function applyAgentSurface(viewId: string): void {
	const view = getBrowserView(viewId);
	if (!view || view.webContents.isDestroyed()) return; // vanished before we surfaced it
	currentViewId = viewId;
	wireNavPushes(viewId, view.webContents);
	if (getAttachedViewId() !== null) {
		showBrowserView(viewId);
		if (lastBoundsDip) setBrowserViewBounds(viewId, lastBoundsDip);
	}
	pushNavState(viewId, view.webContents);
	pushAgentSurfaced(viewId);
}

/**
 * Surface an agent view when the agent's active view changes (agent navigate, or
 * an active-tab "show" op). Follows a blank foreground OR an agent view the
 * SURFACING session owns (`view-<sid>-…`); a hand-navigated page, an adopted
 * view, and other sessions' views are never yanked. See browser-surface-policy.ts.
 */
export function autoSurfaceAgentView(viewId: string, sessionId?: string): void {
	const surface = decideAgentSurface({
		isForegroundFamily: currentViewId === FOREGROUND_ID || currentViewId.startsWith("profile-"),
		isBlank: currentViewIsBlank(),
		currentIsSessionAgentView: isSessionAgentView(currentViewId, sessionId),
	});
	if (surface) applyAgentSurface(viewId);
	sendViewsChanged();
}

/** Ask the renderer to surface the Browser tab for an auto-surfaced agent view. */
function pushAgentSurfaced(viewId: string): void {
	const win = getMainWindow();
	if (!win || win.isDestroyed()) return;
	win.webContents.send("browser-agent-surfaced", { viewId });
}

export function setupBrowserIPC(): void {
	// Pool membership/attachment changes → poke the renderer to re-list, and
	// give every pool view (incl. agent views minted over the server bridge)
	// its find/zoom page controls (browser-page-controls.ts).
	setPoolChangedListener(() => { sendViewsChanged(); wirePageControlsForPool(); });
	// Find-in-page + per-view zoom command surface, acting on currentViewId.
	setupBrowserPageControls(() => currentViewId);

	ipcMain.handle("browser-set-bounds", (event: IpcMainInvokeEvent, rect: Rectangle) => {
		if (!isTrustedBrowserSender(event.sender)) return;
		const { viewId } = ensureCurrentView();
		const zoom = getMainWindow()?.webContents.getZoomFactor() ?? 1;
		lastBoundsDip = scaleRectToDip(rect, zoom);
		setBrowserViewBounds(viewId, lastBoundsDip);
	});

	ipcMain.handle("browser-set-chat-overlay", (
		event: IpcMainInvokeEvent,
		payload: BrowserChatOverlayPayload | null,
	) => {
		if (!isTrustedBrowserSender(event.sender)) return;
		if (!payload) {
			setBrowserChatOverlay(null, null, null);
			return;
		}
		const senderOrigin = new URL(event.sender.getURL()).origin;
		const overlayUrl = new URL(payload.overlayUrl);
		if (overlayUrl.origin !== senderOrigin || overlayUrl.searchParams.get("browserChatOverlay") !== "1") return;
		const zoom = getMainWindow()?.webContents.getZoomFactor() ?? 1;
		setBrowserChatOverlay(scaleRectToDip(payload.bounds, zoom), {
			sessionId: payload.sessionId,
			collapsed: payload.collapsed,
			latestOpen: payload.latestOpen,
		}, overlayUrl.toString());
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
			setBrowserChatOverlay(null, null, null);
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

	// Stop the current view's in-flight load — the renderer's ↻ becomes ✕ while
	// the selected view is loading. Same idiom as browser-reload above.
	ipcMain.handle("browser-stop", (event: IpcMainInvokeEvent) => {
		if (!isTrustedBrowserSender(event.sender)) return;
		getBrowserView(currentViewId)?.webContents.stop();
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

	// Close a tab from the strip. User views close outright. Agent views are
	// closable too — RECOVERABLY: emitAgentViewClosed tells the server child,
	// whose backend marks the tab gone and lazily recreates the view on the
	// agent's next op (its in-flight ops are rejected with a typed view-closed
	// error rather than left to time out). The server bridge's own close guard
	// (agent views only) is unchanged — it protects user views from the server,
	// not agent views from the user.
	// Returns true when the view was closed, false when absent.
	ipcMain.handle("browser-close-view", (event: IpcMainInvokeEvent, viewId: string): boolean => {
		if (!isTrustedBrowserSender(event.sender)) return false;
		const info = listBrowserViews().find((v) => v.viewId === viewId);
		if (!info) return false;
		const wasCurrent = currentViewId === viewId;
		const wasAttached = getAttachedViewId() === viewId;
		closeBrowserView(viewId); // fires the pool-change poke → renderer re-lists
		if (info.agentDriven) emitAgentViewClosed(viewId);
		if (wasCurrent) {
			// The anchor's driven view just went away — fall back to the foreground
			// view (recreated lazily). If the closed tab was on screen, show the
			// fallback so the pane isn't left painting a destroyed view.
			currentViewId = FOREGROUND_ID;
			if (wasAttached) {
				const view = ensureForegroundView();
				showBrowserView(FOREGROUND_ID);
				if (lastBoundsDip) setBrowserViewBounds(FOREGROUND_ID, lastBoundsDip);
				pushNavState(FOREGROUND_ID, view.webContents);
			}
		}
		return true;
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
