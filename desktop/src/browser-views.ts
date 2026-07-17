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
import { getHardenedPartitionSession, hardenWebContents, setViewTrustResolver, viewWebPreferences } from "./browser-partition";
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
}

const DEFAULT_BOUNDS: Rectangle = { x: 0, y: 0, width: 800, height: 600 };

const pool = new Map<string, PoolEntry>();
// webContents.id → agentDriven, for the partition layer's per-request
// user-vs-agent trust question (the user-loopback egress carve-out). Only
// pool views are listed — popups and unknown webContents resolve to null,
// which the policy treats as strict.
const wcTrust = new Map<number, boolean>();
setViewTrustResolver((id) => (wcTrust.has(id) ? (wcTrust.get(id) ? "agent" : "user") : null));
let attachedId: string | null = null;
// Minimal pool-change seam: fired on membership changes (create/close) and
// attach flips (show). No payload by design — the consumer re-lists; the pool
// stays ignorant of who is watching.
let poolChangedListener: (() => void) | null = null;

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
	};
	pool.set(viewId, entry);
	wcTrust.set(entry.wcId, entry.agentDriven);
	try {
		viewObserver?.onViewCreated(viewId, view.webContents, entry.agentDriven);
	} catch {
		/* perception must never break view creation */
	}
	notifyPoolChanged();
	return describe(viewId, entry);
}

export function getBrowserView(viewId: string): WebContentsView | undefined {
	return pool.get(viewId)?.view;
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
	win.contentView.addChildView(entry.view);
	entry.view.setBounds(entry.bounds);
	attachedId = viewId;
	if (flipped) notifyPoolChanged();
}

/** Detach from the main window. The view stays live in the pool. */
export function hideBrowserView(viewId: string): void {
	const entry = requireEntry(viewId);
	if (attachedId !== viewId) return;
	const win = getMainWindow();
	if (win && !win.isDestroyed()) win.contentView.removeChildView(entry.view);
	attachedId = null;
}

export function setBrowserViewBounds(viewId: string, bounds: Rectangle): void {
	const entry = requireEntry(viewId);
	entry.bounds = bounds;
	if (attachedId === viewId) entry.view.setBounds(bounds);
}

export function closeBrowserView(viewId: string): void {
	const entry = requireEntry(viewId);
	if (attachedId === viewId) hideBrowserView(viewId);
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
	notifyPoolChanged();
}

/** Liveness probe: does the view exist and is its renderer alive? */
export function pingBrowserView(viewId: string): { ok: boolean; url?: string; title?: string } {
	const entry = pool.get(viewId);
	if (!entry || entry.view.webContents.isDestroyed()) return { ok: false };
	return { ok: true, url: entry.view.webContents.getURL(), title: entry.view.webContents.getTitle() };
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
