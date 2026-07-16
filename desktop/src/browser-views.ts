/**
 * Local Agent X — Browser view pool
 *
 * WebContentsViews keyed by viewId, each on a hardened per-profile
 * partition (browser-partition.ts). At most ONE view is attached to
 * the main window at a time — showing a view implicitly detaches the
 * previous one. Detached views stay live (still loadable/driveable);
 * only close() destroys them.
 */

import { WebContentsView, type Rectangle } from "electron";

import { getMainWindow } from "./window";
import { getHardenedPartitionSession, hardenWebContents, viewWebPreferences } from "./browser-partition";
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
}

const DEFAULT_BOUNDS: Rectangle = { x: 0, y: 0, width: 800, height: 600 };

const pool = new Map<string, PoolEntry>();
let attachedId: string | null = null;

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
	// window.open children would inherit the partition but NOT the
	// per-webContents hardening (WebRTC policy) and would live outside
	// the pool as unmanaged OS windows — deny them outright. In-view
	// navigation stays free; the session egress guard covers it.
	view.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
	const entry: PoolEntry = {
		view,
		partition: opts.partition,
		bounds: opts.bounds ?? { ...DEFAULT_BOUNDS },
		agentDriven: opts.agentDriven === true,
	};
	pool.set(viewId, entry);
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
	win.contentView.addChildView(entry.view);
	entry.view.setBounds(entry.bounds);
	attachedId = viewId;
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
	if (!entry.view.webContents.isDestroyed()) entry.view.webContents.close();
	pool.delete(viewId);
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
