/**
 * Browser IPC — renderer control of the in-app browser view pool.
 *
 * The right-panel Browser tab (public/js/browser-tab.js) reserves one anchor
 * region in the DOM; the page itself is a WebContentsView from the
 * browser-views pool, drawn by main as an OS-level overlay. These handlers
 * translate the renderer's rect/visibility reports and nav commands onto the
 * pool, and push nav-state back so the address bar mirrors the real webContents.
 *
 * Multi-view: the renderer's anchor drives ONE "current" view at a time, but
 * the pool may hold many — each chat's own lazily created home view and user
 * tabs PLUS the agent-driving per-chat views created over the server bridge
 * (server-bridge-browser.ts). The pane belongs to the chat on screen
 * (browser-chat-views.ts): browser-bind-chat says which chat that is, the
 * current view is that chat's, browser-list-views lists that chat's views,
 * and browser-switch-view flips which one is attached + driven from the anchor; showBrowserView keeps the others live-but-detached
 * (the D1 invariant — background views keep running their in-flight ops).
 * Nav-state pushes are tagged with the viewId they describe so the renderer
 * only updates the address bar for the view it is currently showing.
 */

import { ipcMain, type BrowserWindowConstructorOptions, type IpcMainInvokeEvent, type Rectangle, type WebContentsView } from "electron";

import { prepareEmbeddedChromeIdentityForNavigation } from "./embedded-chrome-identity";
import { getMainWindow } from "./window";
import { isTrustedBrowserSender, setupBrowserPageControls, wirePageControlsForPool } from "./browser-page-controls";
import { setupBrowserDownloadsIPC } from "./browser-downloads-ipc";
import { setupBrowserPermissionBarIPC } from "./browser-permission-bar-ipc";
// The trusted-sender guard moved to browser-page-controls.ts in the find/zoom
// split; re-exported so existing consumers keep importing it from here.
export { isTrustedBrowserSender } from "./browser-page-controls";
import {
	closeBrowserView,
	createBrowserView,
	getAttachedViewId,
	getBrowserView,
	hideBrowserView,
	listBrowserViews,
	setBrowserChatOverlay,
	setAgentViewEvictedNotifier,
	setBrowserViewBounds,
	setPaneTabOpener,
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
import {
	boundChat,
	claimUnownedViews,
	claimUserView,
	currentViewId,
	forgetView,
	homeViewId,
	isHomeViewId,
	isRested,
	noteBackgroundAgentView,
	restedViewsOf,
	setBoundChat,
	setCurrentViewId,
	shownInBoundChat,
	userViewOwner,
} from "./browser-chat-views";
import { closeChatViews, restIdlePages, startPageRestTimer, wakeRestedPage } from "./browser-chat-pages";
import { sessionIdFromViewId } from "./contract/browser-view-ids";
import { SHARED_BROWSER_PARTITION } from "./browser-partition";
import { markHumanNavigation } from "./in-app-browser";

interface BrowserViewListEntry {
	viewId: string;
	url: string;
	title: string;
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

// The view the renderer's anchor currently drives (bounds/visibility/nav) is
// currentViewId(): the chat on screen's (browser-chat-views.ts). The renderer
// flips it with browser-switch-view; it defaults to the chat's home view, which
// the tab lazily creates for the user.
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

/** Lazily create the home view of the chat on screen on first use and wire it. */
function ensureHomeView(): { viewId: string; view: WebContentsView } {
	const viewId = homeViewId();
	let view = getBrowserView(viewId);
	if (!view) {
		createBrowserView(viewId, { partition: SHARED_BROWSER_PARTITION, agentDriven: false });
		claimUserView(viewId);
		view = getBrowserView(viewId)!;
	}
	wireNavPushes(viewId, view.webContents);
	return { viewId, view };
}

/** The view the renderer's anchor drives. The chat's home view is created on
 *  demand; any other current view (set only by a successful switch to an
 *  existing pool view) is looked up — a vanished one falls back to home. */
function ensureCurrentView(): { viewId: string; view: WebContentsView } {
	const viewId = currentViewId();
	if (!isHomeViewId(viewId)) {
		const view = getBrowserView(viewId) ?? wakeRestedPage(viewId);
		if (view) {
			wireNavPushes(viewId, view.webContents);
			return { viewId, view };
		}
		forgetView(viewId); // switched-to view was closed underneath us
	}
	const home = ensureHomeView();
	setCurrentViewId(home.viewId);
	return home;
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
function viewIsBlank(viewId: string): boolean {
	const view = getBrowserView(viewId);
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
	setCurrentViewId(viewId);
	wireNavPushes(viewId, view.webContents);
	if (lastBoundsDip) setBrowserViewBounds(viewId, lastBoundsDip); // negotiate BEFORE any attach
	if (getAttachedViewId() !== null) {
		showBrowserView(viewId);
	}
	pushNavState(viewId, view.webContents);
	pushAgentSurfaced(viewId);
}

/**
 * Surface an agent view when the agent's active view changes (agent navigate, or
 * an active-tab "show" op). Follows a blank foreground OR an agent view the
 * SURFACING session owns (`view-<sid>-…`); a hand-navigated page, an adopted
 * view, and other sessions' views are never yanked. See browser-surface-policy.ts.
 *
 * Only the chat on screen moves the pane. A view of another chat is noted as
 * what that chat's pane shows when the user comes back to it, and nothing on
 * screen changes: an agent browsing in a chat nobody was looking at used to
 * take a blank pane and turn the panel to BROWSER (2026-11-22).
 */
export function autoSurfaceAgentView(viewId: string, sessionId?: string): void {
	const chat = sessionIdFromViewId(viewId);
	if (chat && chat !== boundChat()) {
		noteBackgroundAgentView(viewId, chat, (current) => !viewIsBlank(current));
		return;
	}
	const current = currentViewId();
	const surface = decideAgentSurface({
		isForegroundFamily: isHomeViewId(current) || current.startsWith("user-"),
		isBlank: viewIsBlank(current),
		currentIsSessionAgentView: isSessionAgentView(current, sessionId),
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

/** Mint a user tab (agentDriven:false) on the shared browser identity, owned by
 *  the chat on screen, and make it the anchor's view. Attach only if something is already attached — on a
 *  non-browser tab the retarget alone is enough (the next set-visible shows it),
 *  and the renderer adopts an attached view on its next re-list. `openedBy`
 *  hosts a page's own new-tab open (browser-view-popups.ts). */
function openUserTab(openedBy?: BrowserWindowConstructorOptions): { viewId: string; view: WebContentsView } {
	const viewId = `user-${++userTabSeq}`;
	createBrowserView(viewId, { partition: SHARED_BROWSER_PARTITION, agentDriven: false, openedBy });
	const view = getBrowserView(viewId)!;
	claimUserView(viewId);
	wireNavPushes(viewId, view.webContents);
	setCurrentViewId(viewId);
	if (lastBoundsDip) setBrowserViewBounds(viewId, lastBoundsDip); // negotiate BEFORE any attach
	if (getAttachedViewId() !== null) {
		showBrowserView(viewId);
	}
	markHumanNavigation(viewId);
	return { viewId, view };
}

/** Another chat came on screen (or none): the pane is that chat's now. The
 *  chat left behind keeps its views, live and detached; a home view it never
 *  used is closed instead of kept. If a view was on screen, the new chat's
 *  current view takes its place. Returns that view's nav-state, or null when
 *  the pane is not showing. */
function bindChat(chat: string | null): BrowserNavState | null {
	if ((chat || null) === boundChat()) return null;
	const wasAttached = getAttachedViewId() !== null;
	const leftHome = homeViewId();
	if (getBrowserView(leftHome) && viewIsBlank(leftHome)) {
		closeBrowserView(leftHome);
		forgetView(leftHome);
	}
	setBoundChat(chat);
	const here = boundChat();
	if (here) {
		claimUnownedViews(listBrowserViews().filter((v) => !v.agentDriven && !userViewOwner(v.viewId)).map((v) => v.viewId), here);
	}
	sendViewsChanged();
	restIdlePages(); // the chat just left may have pushed the loaded pages past their cap
	if (!wasAttached) return null;
	const { viewId, view } = ensureCurrentView();
	if (lastBoundsDip) setBrowserViewBounds(viewId, lastBoundsDip); // negotiate BEFORE the attach
	showBrowserView(viewId);
	pushNavState(viewId, view.webContents);
	return readNavState(viewId, view.webContents);
}

export function setupBrowserIPC(): void {
	// A link on a user's page that asks for a new tab opens as a tab here, not
	// as a separate window. The opener is already loading it, so this only
	// hosts it; the identity override covers the tab's later navigations.
	setPaneTabOpener((_openerViewId, options) => {
		const { view } = openUserTab(options);
		void prepareEmbeddedChromeIdentityForNavigation(view.webContents);
		return view.webContents;
	});
	// Pool membership/attachment changes → poke the renderer to re-list, and
	// give every pool view (incl. agent views minted over the server bridge)
	// its find/zoom page controls (browser-page-controls.ts).
	setPoolChangedListener(() => { sendViewsChanged(); wirePageControlsForPool(); });
	setAgentViewEvictedNotifier(emitAgentViewClosed); // LRU eviction → server, like a user ✕-close
	// Find-in-page + per-view zoom command surface, acting on the current view.
	setupBrowserPageControls(currentViewId);
	setupBrowserDownloadsIPC();
	setupBrowserPermissionBarIPC();
	startPageRestTimer();

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
		} else if (getBrowserView(currentViewId())) {
			// Don't create a view just to hide it — hiding a non-existent view is a
			// no-op, not an error.
			hideBrowserView(currentViewId());
			setBrowserChatOverlay(null, null, null);
		}
	});

	ipcMain.handle("browser-navigate", async (event: IpcMainInvokeEvent, url: string) => {
		if (!isTrustedBrowserSender(event.sender)) {
			console.warn(`[browser.ipc] rejected manual navigate from untrusted sender: ${url}`);
			return;
		}
		const { viewId, view } = ensureCurrentView();
		console.log(`[browser.ipc] manual navigate view=${viewId} url=${url}`);
		// loadURL rejects on ERR_ABORTED (redirects, rapid re-navigation) — that's
		// normal browsing, not an error to surface. Nav-state events carry the real
		// outcome either way.
		await prepareEmbeddedChromeIdentityForNavigation(view.webContents);
		markHumanNavigation(viewId);
		// The user pressed Enter in the address bar: the page they asked for
		// takes focus, as in any browser. Views no longer take it on their own
		// navigations (viewWebPreferences' focusOnNavigation).
		view.webContents.focus();
		await view.webContents.loadURL(url).catch((error: unknown) => {
			const message = error instanceof Error ? error.message : String(error);
			if (!message.includes("ERR_ABORTED")) {
				console.error(`[browser.ipc] manual navigate rejected view=${viewId} url=${url}: ${message}`);
			}
		});
	});

	ipcMain.handle("browser-go-back", (event: IpcMainInvokeEvent) => {
		if (!isTrustedBrowserSender(event.sender)) return;
		const wc = getBrowserView(currentViewId())?.webContents;
		if (wc && wc.navigationHistory.canGoBack()) wc.navigationHistory.goBack();
	});

	ipcMain.handle("browser-go-forward", (event: IpcMainInvokeEvent) => {
		if (!isTrustedBrowserSender(event.sender)) return;
		const wc = getBrowserView(currentViewId())?.webContents;
		if (wc && wc.navigationHistory.canGoForward()) wc.navigationHistory.goForward();
	});

	ipcMain.handle("browser-reload", (event: IpcMainInvokeEvent) => {
		if (!isTrustedBrowserSender(event.sender)) return;
		getBrowserView(currentViewId())?.webContents.reload();
	});

	// Stop the current view's in-flight load — the renderer's ↻ becomes ✕ while
	// the selected view is loading. Same idiom as browser-reload above.
	ipcMain.handle("browser-stop", (event: IpcMainInvokeEvent) => {
		if (!isTrustedBrowserSender(event.sender)) return;
		getBrowserView(currentViewId())?.webContents.stop();
	});

	ipcMain.handle("browser-get-nav-state", (event: IpcMainInvokeEvent): BrowserNavState | null => {
		if (!isTrustedBrowserSender(event.sender)) return null;
		const viewId = currentViewId();
		const view = getBrowserView(viewId);
		return view ? readNavState(viewId, view.webContents) : emptyNavState(viewId);
	});

	// The chat on screen changed (public/js/browser-session-bind.js).
	ipcMain.handle("browser-bind-chat", (event: IpcMainInvokeEvent, chat: unknown): BrowserNavState | null => {
		if (!isTrustedBrowserSender(event.sender)) return null;
		return bindChat(typeof chat === "string" && chat ? chat : null);
	});

	// Enumerate the pool views of the chat on screen (its home view and user
	// tabs + its agent-driven views) so the tab's switcher lists every view the
	// user might watch in this chat, and none of another chat's.
	ipcMain.handle("browser-list-views", (event: IpcMainInvokeEvent): BrowserViewListEntry[] | null => {
		if (!isTrustedBrowserSender(event.sender)) return null;
		const live = listBrowserViews().filter((v) => shownInBoundChat(v.viewId, v.agentDriven)).map((v) => ({
			viewId: v.viewId,
			url: v.url,
			title: v.title,
			attached: v.attached,
			agentDriven: v.agentDriven,
		}));
		// A resting page keeps its tab: showing it loads its address again.
		const resting = restedViewsOf().map((r) => ({ viewId: r.viewId, url: r.url, title: r.title, attached: false, agentDriven: false }));
		return [...live, ...resting];
	});

	// A chat was deleted (public/js/browser-session-bind.js closeChat).
	ipcMain.handle("browser-close-chat", (event: IpcMainInvokeEvent, chat: unknown): void => {
		if (!isTrustedBrowserSender(event.sender)) return;
		if (typeof chat !== "string" || !chat) return;
		if (boundChat() === chat) bindChat(null); // the pane leaves the chat before its views close
		closeChatViews(chat);
		sendViewsChanged();
	});

	// Flip which pool view the anchor drives + shows. The target must already
	// exist (agent views are created over the bridge; the foreground view by the
	// tab). showBrowserView detaches the previous view but keeps it LIVE, so its
	// in-flight agent ops keep running while the user watches another view.
	ipcMain.handle("browser-switch-view", (event: IpcMainInvokeEvent, viewId: string): BrowserNavState | null => {
		if (!isTrustedBrowserSender(event.sender)) return null;
		const view = viewId === homeViewId() ? ensureHomeView().view : getBrowserView(viewId) ?? wakeRestedPage(viewId);
		if (!view) return null; // vanished/never-existed — renderer re-lists and recovers
		setCurrentViewId(viewId);
		wireNavPushes(viewId, view.webContents);
		showBrowserView(viewId);
		// Snap the newly shown view to the anchor geometry (an agent view carries
		// its own default pool bounds until now).
		if (lastBoundsDip) setBrowserViewBounds(viewId, lastBoundsDip);
		const state = readNavState(viewId, view.webContents);
		pushNavState(viewId, view.webContents); // mirror immediately for late subscribers
		return state;
	});

	// Close a tab from the strip. User views close outright. Agent views close
	// RECOVERABLY: emitAgentViewClosed tells the server child, whose backend marks
	// the tab gone and lazily recreates it on the agent's next op (in-flight ops
	// reject with a typed view-closed error). The server bridge's own close guard
	// (agent views only) protects user views from the server, not the reverse.
	// Returns true when the view was closed, false when absent.
	ipcMain.handle("browser-close-view", (event: IpcMainInvokeEvent, viewId: string): boolean => {
		if (!isTrustedBrowserSender(event.sender)) return false;
		const info = listBrowserViews().find((v) => v.viewId === viewId);
		if (!info && isRested(viewId)) {
			forgetView(viewId); // a resting page has no view to close: only its tab goes
			sendViewsChanged();
			return true;
		}
		if (!info) return false;
		const wasCurrent = currentViewId() === viewId;
		const wasAttached = getAttachedViewId() === viewId;
		closeBrowserView(viewId); // fires the pool-change poke → renderer re-lists
		forgetView(viewId);
		if (info.agentDriven) emitAgentViewClosed(viewId);
		if (wasCurrent && wasAttached) {
			// The anchor's driven view just went away — forgetView put the chat back
			// on its home view (recreated lazily). The closed tab was on screen, so
			// show the fallback: the pane isn't left painting a destroyed view.
			const home = ensureHomeView();
			showBrowserView(home.viewId);
			if (lastBoundsDip) setBrowserViewBounds(home.viewId, lastBoundsDip);
			pushNavState(home.viewId, home.view.webContents);
		}
		return true;
	});

	// New user tab ("+" or a chat link): mint it, then load the url.
	ipcMain.handle("browser-new-tab", async (event: IpcMainInvokeEvent, url?: string): Promise<BrowserNavState | null> => {
		if (!isTrustedBrowserSender(event.sender)) return null;
		const { viewId, view } = openUserTab();
		const target = (typeof url === "string" && url.trim()) || "about:blank";
		await prepareEmbeddedChromeIdentityForNavigation(view.webContents);
		await view.webContents.loadURL(target).catch(() => { /* ERR_ABORTED etc. — nav-state carries the real outcome */ });
		const state = readNavState(viewId, view.webContents);
		pushNavState(viewId, view.webContents);
		return state;
	});
}
