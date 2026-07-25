/**
 * Local Agent X — Browser view pool
 *
 * WebContentsViews keyed by viewId, each on a hardened per-profile
 * partition (browser-partition.ts). At most ONE view is attached to
 * the main window at a time — showing a view implicitly detaches the
 * previous one. Detached views stay live (still loadable/driveable);
 * only close() destroys them.
 */

import { WebContentsView, type Rectangle, type WebContents } from "electron";

import { getMainWindow } from "./window";
// The chat overlay moved to browser-chat-overlay.ts (this file sits at the
// 400-LOC ceiling); its lifetime is driven from here because the pool owns
// which view is attached.
import { applyChatOverlay, attachChatOverlay, detachChatOverlay, type BrowserChatOverlayState } from "./browser-chat-overlay";
import { getHardenedPartitionSession, hardenWebContents, setViewTrustResolver, viewWebPreferences } from "./browser-partition";
import { viewTrust } from "./browser-download-routing";
import { managePopups, type PopupTracker } from "./browser-view-popups";
import { armCoDrive } from "./in-app-browser";

export interface BrowserViewInfo {
	viewId: string;
	partition: string;
	url: string;
	title: string;
	attached: boolean;
	/** Provenance, set at creation: true when the server's agent-driving bridge
	 *  path created the view (per-(session,profile) view), false when the
	 *  renderer's Browser tab created its own foreground view. Real state, not a
	 *  heuristic — the switcher badges agent-driven views from this. */
	agentDriven: boolean;
}

interface PoolEntry {
	view: WebContentsView;
	partition: string;
	bounds: Rectangle;
	agentDriven: boolean;
	popups: PopupTracker;
	/** webContents.id captured at creation — cleanup must not read it off a
	 *  possibly-destroyed webContents. */
	wcId: number;
	/** Monotonic recency for LRU eviction (create / attach / ping). A counter,
	 *  not a clock, so ties never collide and tests stay deterministic. */
	lastActiveSeq: number;
	/** Has REAL geometry been agreed for this view? True from explicit create
	 *  bounds or from a setBrowserViewBounds report (the renderer's measured
	 *  anchor rect — that report IS the negotiation). While false, `bounds` is
	 *  only the DEFAULT_BOUNDS placeholder, so the view attaches HIDDEN. */
	boundsNegotiated: boolean;
	/** Fail-open handle armed when an un-negotiated view attaches; cleared on
	 *  negotiation, hide and close. */
	revealTimer: ReturnType<typeof setTimeout> | null;
}

// Placeholder rect for a view whose geometry has NOT been negotiated yet. It is
// a guess that is correct nowhere, so it must never be painted: setBounds needs
// *some* value at attach time, but whether the view is actually shown is gated
// on entry.boundsNegotiated (see showBrowserView / setBrowserViewBounds).
const DEFAULT_BOUNDS: Rectangle = { x: 0, y: 0, width: 800, height: 600 };

// Cap on DETACHED, agent-driven views kept alive in the pool. Each live view is
// a full renderer; with per-chat browsers, unbounded background views starve
// the desktop process (the CPU/main-thread contention that expired op leases
// mid-run). Attached and user views are never evicted; the LRU detached agent
// view is closed (recoverably — the server recreates it on the agent's next op)
// when a new agent view would push past the cap.
const MAX_DETACHED_AGENT_VIEWS = 4;
let activityClock = 0;
// Server-notify seam (wired to emitAgentViewClosed in browser-ipc). An evicted
// agent view must reach the server the same way a user ✕-close does, so the
// owning backend marks the tab gone and recreates it lazily.
let agentViewEvictedNotifier: ((viewId: string) => void) | null = null;
export function setAgentViewEvictedNotifier(fn: ((viewId: string) => void) | null): void {
	agentViewEvictedNotifier = fn;
}

const pool = new Map<string, PoolEntry>();
// webContents.id → agentDriven, for the partition layer's per-request
// user-vs-agent trust question (loopback carve-out + download routing). Only
// pool views are listed — popups and unknown webContents resolve to null,
// which the policies treat as strict. Adoption (server push, mirrored via
// setViewAdopted) flips a user view to "agent" while the agent drives it —
// see viewTrust in browser-download-routing.ts for why.
const wcTrust = new Map<number, boolean>();
const adoptedViews = new Set<string>();
setViewTrustResolver((id) => {
	if (!wcTrust.has(id)) return null;
	return viewTrust(wcTrust.get(id), adoptedViews.has(viewIdForWebContents(id) ?? ""));
});

/** Server-pushed adoption mirror (lifecycle "adopt"/"release"): the agent
 *  took over / let go of a user view. */
export function setViewAdopted(viewId: string, adopted: boolean): void {
	if (adopted) adoptedViews.add(viewId);
	else adoptedViews.delete(viewId);
}

/** A (re)spawned server child means every old adoption died with its backend
 *  and no "release" will ever arrive — without this, a mid-adoption server
 *  crash left the user's own tab quarantining downloads until it closed. */
export function clearAdoptedViews(): void {
	adoptedViews.clear();
}
let attachedId: string | null = null;
// Minimal pool-change seam: fired on membership changes (create/close) and
// attach flips (show). No payload by design — the consumer re-lists; the pool
// stays ignorant of who is watching.
let poolChangedListener: (() => void) | null = null;

/** Renderer-driven overlay report, forwarded to browser-chat-overlay.ts with
 *  the pool's current attachment bound on. The overlay may only float above an
 *  attached view, and `attachedId` lives here — passing it in keeps this file
 *  the single owner instead of exporting mutable state for two modules to
 *  read. */
export function setBrowserChatOverlay(
	bounds: Rectangle | null,
	state: BrowserChatOverlayState | null,
	url: string | null,
): void {
	applyChatOverlay(bounds, state, url, attachedId);
}

export function setPoolChangedListener(fn: (() => void) | null): void {
	poolChangedListener = fn;
}

/** Per-view lifecycle observation seam — browser-perception.ts registers here
 *  (via server-bridge-browser's wire call) to arm console capture + UI-event
 *  production without the pool importing perception. Same posture as the
 *  pool-change listener: optional, and a throwing observer must never break
 *  view lifecycle. */
export interface ViewLifecycleObserver {
	onViewCreated(viewId: string, wc: WebContents, agentDriven: boolean): void;
	onViewClosed(viewId: string): void;
}

let viewObserver: ViewLifecycleObserver | null = null;

export function setViewLifecycleObserver(obs: ViewLifecycleObserver | null): void {
	viewObserver = obs;
}

function notifyPoolChanged(): void {
	poolChangedListener?.();
}

/** The viewId currently attached to the main window, or null when detached. */
export function getAttachedViewId(): string | null {
	return attachedId;
}

function requireEntry(viewId: string): PoolEntry {
	const entry = pool.get(viewId);
	if (!entry) throw new Error(`no browser view "${viewId}"`);
	return entry;
}

/**
 * Create a pooled view. It is created DETACHED — attaching to the window is a
 * separate, explicit showBrowserView() call. That is exactly what an
 * app-open-but-panel-closed background/cron agent needs: create the view for its
 * (session, profile), drive it (loadURL / co-drive / bridge ops) while it stays
 * hidden, and never call showBrowserView. The webContents is fully live from
 * creation, so no separate headless-window system is required. (Only a fully
 * CLOSED app has no Electron process at all — that case falls to the CDP
 * backend, which now carries the profile's userDataDir.)
 */
export function createBrowserView(
	viewId: string,
	opts: { partition: string; bounds?: Rectangle; agentDriven?: boolean },
): BrowserViewInfo {
	if (pool.has(viewId)) throw new Error(`browser view "${viewId}" already exists`);
	// Harden the partition BEFORE any webContents exists on it, so the
	// first request already runs under the egress/permission stack.
	getHardenedPartitionSession(opts.partition);
	const view = new WebContentsView({ webPreferences: viewWebPreferences(opts.partition) });
	hardenWebContents(view.webContents);
	armCoDrive(viewId, view.webContents);
	// Stamp a per-view marker on the top frame so the CDP driver (electron-cdp.ts)
	// can map this viewId back to its Playwright Page via window.name. Fire-and-forget.
	view.webContents.executeJavaScript(`window.name=${JSON.stringify(viewId)}`).catch(() => {});
	// window.open children (popup-mode OAuth lives or dies on these) get the
	// managed discipline: same-partition webPreferences, per-webContents
	// hardening, recursive window-open handling, and a tracked lifetime that
	// ends with the view. Session guards (egress, permissions, downloads)
	// ride the partition and cover them already.
	const popups = managePopups(view.webContents, {
		webPreferences: () => viewWebPreferences(opts.partition),
		harden: hardenWebContents,
	});
	const entry: PoolEntry = {
		view,
		partition: opts.partition,
		bounds: opts.bounds ?? { ...DEFAULT_BOUNDS },
		agentDriven: opts.agentDriven === true,
		popups,
		wcId: view.webContents.id,
		lastActiveSeq: ++activityClock,
		boundsNegotiated: opts.bounds !== undefined,
		revealTimer: null,
	};
	pool.set(viewId, entry);
	wcTrust.set(entry.wcId, entry.agentDriven);
	try {
		viewObserver?.onViewCreated(viewId, view.webContents, entry.agentDriven);
	} catch {
		/* perception must never break view creation */
	}
	evictDetachedAgentViewsOverCap(viewId);
	notifyPoolChanged();
	return describe(viewId, entry);
}

/** Enforce MAX_DETACHED_AGENT_VIEWS: close the least-recently-active detached
 *  agent views until the cap holds. Never touches the attached view, user
 *  views, or the just-created `keepId`. */
function evictDetachedAgentViewsOverCap(keepId: string): void {
	const detachedAgent = [...pool.entries()]
		.filter(([id, e]) => e.agentDriven && id !== attachedId && id !== keepId)
		.sort((a, b) => a[1].lastActiveSeq - b[1].lastActiveSeq);
	// keepId counts toward the cap but is never itself the eviction target.
	const overflow = detachedAgent.length + 1 - MAX_DETACHED_AGENT_VIEWS;
	for (let i = 0; i < overflow && i < detachedAgent.length; i++) {
		const evictId = detachedAgent[i][0];
		closeBrowserView(evictId);
		try { agentViewEvictedNotifier?.(evictId); } catch { /* child gone — backend closes with the session */ }
	}
}

export function getBrowserView(viewId: string): WebContentsView | undefined {
	return pool.get(viewId)?.view;
}

// Bounded fail-open for the hidden-until-negotiated invariant: if the renderer
// never reports an anchor rect (panel crashed, never mounted), reveal the view
// anyway at whatever bounds it has. Visible-but-misplaced beats a black hole.
const UNNEGOTIATED_REVEAL_MS = 2000;

function clearRevealTimer(entry: PoolEntry): void {
	if (entry.revealTimer) clearTimeout(entry.revealTimer);
	entry.revealTimer = null;
}

/** Attach to the main window (detaching whichever view was attached). */
export function showBrowserView(viewId: string): void {
	const entry = requireEntry(viewId);
	const win = getMainWindow();
	if (!win || win.isDestroyed()) throw new Error("main window not available");
	if (attachedId && attachedId !== viewId) {
		const prev = pool.get(attachedId);
		if (prev) win.contentView.removeChildView(prev.view);
		attachedId = null;
	}
	const flipped = attachedId !== viewId;
	// Order is load-bearing: addChildView paints IMMEDIATELY, so bounds and
	// visibility must be on the view BEFORE it joins the tree (the overlay's own
	// attachChatOverlay does the same). A view with no negotiated geometry
	// carries only the DEFAULT_BOUNDS placeholder, so it attaches invisible —
	// setVisible keeps it attached and live while unpainted — and
	// setBrowserViewBounds reveals it the moment the renderer reports its
	// measured anchor.
	entry.view.setBounds(entry.bounds);
	entry.view.setVisible(entry.boundsNegotiated);
	win.contentView.addChildView(entry.view);
	clearRevealTimer(entry);
	if (!entry.boundsNegotiated) {
		const timer = setTimeout(() => {
			entry.revealTimer = null;
			if (entry.boundsNegotiated || attachedId !== viewId) return;
			entry.view.setBounds(entry.bounds);
			entry.view.setVisible(true);
		}, UNNEGOTIATED_REVEAL_MS);
		timer.unref?.(); // never hold the process open for a reveal
		entry.revealTimer = timer;
	}
	attachedId = viewId;
	entry.lastActiveSeq = ++activityClock; // showing a view is activity (LRU)
	attachChatOverlay(attachedId);
	if (flipped) notifyPoolChanged();
}

/** Detach from the main window. The view stays live in the pool. */
export function hideBrowserView(viewId: string): void {
	const entry = requireEntry(viewId);
	if (attachedId !== viewId) return;
	const win = getMainWindow();
	if (win && !win.isDestroyed()) win.contentView.removeChildView(entry.view);
	clearRevealTimer(entry); // nothing to reveal once detached
	detachChatOverlay();
	attachedId = null;
}

export function setBrowserViewBounds(viewId: string, bounds: Rectangle): void {
	const entry = requireEntry(viewId);
	entry.bounds = bounds;
	// The renderer reporting its measured anchor rect IS the negotiation.
	const firstNegotiation = !entry.boundsNegotiated;
	entry.boundsNegotiated = true;
	clearRevealTimer(entry);
	if (attachedId !== viewId) return;
	entry.view.setBounds(bounds);
	if (firstNegotiation) entry.view.setVisible(true); // real geometry — safe to paint
}

export function closeBrowserView(viewId: string): void {
	const entry = requireEntry(viewId);
	if (attachedId === viewId) hideBrowserView(viewId);
	clearRevealTimer(entry); // hide covers the attached case; this covers the rest
	entry.popups.closeAll();
	try {
		// Observed BEFORE the webContents dies so listener cleanup still has a
		// live target; also frees the view's console ring (no leak on close).
		viewObserver?.onViewClosed(viewId);
	} catch {
		/* perception must never break view teardown */
	}
	if (!entry.view.webContents.isDestroyed()) entry.view.webContents.close();
	pool.delete(viewId);
	wcTrust.delete(entry.wcId);
	adoptedViews.delete(viewId);
	notifyPoolChanged();
}

/** Liveness probe: does the view exist and is its renderer alive? Carries the
 *  view's layout bounds so the server's observation pipeline labels
 *  inViewport against the REAL pane size instead of a 1280×800 default
 *  (entry.bounds is the stored intent — applied on attach, valid while
 *  detached too). */
export function pingBrowserView(viewId: string): { ok: boolean; url?: string; title?: string; bounds?: { width: number; height: number } } {
	const entry = pool.get(viewId);
	if (!entry || entry.view.webContents.isDestroyed()) return { ok: false };
	entry.lastActiveSeq = ++activityClock; // agent driving a detached view keeps it off the LRU chopping block
	return {
		ok: true,
		url: entry.view.webContents.getURL(),
		title: entry.view.webContents.getTitle(),
		bounds: { width: entry.bounds.width, height: entry.bounds.height },
	};
}

export function listBrowserViews(): BrowserViewInfo[] {
	return [...pool.entries()].map(([viewId, entry]) => describe(viewId, entry));
}

/** Reverse lookup: the pool viewId owning a webContents id, or null. The egress
 *  evaluator uses it to attribute a request's webContents to its view so the
 *  server can resolve the owning session for the taint scan. Matches the cached
 *  wcId (stable for the entry's life); a destroyed view is skipped. */
export function viewIdForWebContents(webContentsId: number): string | null {
	for (const [viewId, entry] of pool) {
		if (entry.wcId === webContentsId && !entry.view.webContents.isDestroyed()) return viewId;
	}
	return null;
}

function describe(viewId: string, entry: PoolEntry): BrowserViewInfo {
	const wc = entry.view.webContents;
	const alive = !wc.isDestroyed();
	return {
		viewId,
		partition: entry.partition,
		url: alive ? wc.getURL() : "",
		title: alive ? wc.getTitle() : "",
		attached: attachedId === viewId,
		agentDriven: entry.agentDriven,
	};
}
