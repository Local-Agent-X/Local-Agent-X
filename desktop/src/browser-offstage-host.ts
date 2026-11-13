/**
 * Local Agent X — the hidden window detached browser views live in.
 *
 * A view not attached to the main window had no parent and no size, so it
 * rendered nothing: a screenshot of the app the agent had just built came
 * back empty, or capturePage() never returned and the server gave up at the
 * bridge timeout (phone sessions and a chat with the pane closed, the traced
 * code runs of 2026-11). A detached view is parked here instead: a never-shown
 * window at a real size, the way probeApp (server-bridge.ts) renders a page it
 * checks. Showing a view moves it to the main window as before.
 *
 * The host is a child of the main window, so it closes when the main window
 * really closes and the app still quits on "all windows closed"; while the
 * main window only hides to the tray, background agents keep a host.
 */
import { BrowserWindow, type WebContentsView } from "electron";

import { getMainWindow } from "./window";

/** The size an un-negotiated view renders at offstage: the default the
 *  server's observation pipeline assumes for a view with no pane rect. */
export const OFFSTAGE_SIZE = { width: 1280, height: 800 } as const;

let host: BrowserWindow | null = null;

function hostWindow(): BrowserWindow | null {
	if (host && !host.isDestroyed()) return host;
	const parent = getMainWindow();
	if (!parent || parent.isDestroyed()) return null;
	host = new BrowserWindow({
		parent,
		show: false,
		width: OFFSTAGE_SIZE.width,
		height: OFFSTAGE_SIZE.height,
		skipTaskbar: true,
		focusable: false,
		paintWhenInitiallyHidden: true,
		// The host's own page is blank; the parked views carry their own
		// webPreferences (browser-partition.ts viewWebPreferences).
		webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: true, backgroundThrottling: false },
	});
	host.on("closed", () => { host = null; });
	return host;
}

/** Park a detached view offstage at `size`. A no-op without a main window
 *  (the view then stays parentless, as before the host existed). */
export function parkView(view: WebContentsView, size: { width: number; height: number }): void {
	const win = hostWindow();
	if (!win) return;
	view.setBounds({ x: 0, y: 0, width: Math.max(1, size.width), height: Math.max(1, size.height) });
	view.setVisible(true);
	win.contentView.addChildView(view);
}

/** Take a view out of the host, before it joins the main window or closes. */
export function unparkView(view: WebContentsView): void {
	if (!host || host.isDestroyed()) return;
	if (host.contentView.children.includes(view)) host.contentView.removeChildView(view);
}

/** Resize a parked view (its pane rect changed while it was detached). */
export function resizeParkedView(view: WebContentsView, size: { width: number; height: number }): void {
	if (!host || host.isDestroyed() || !host.contentView.children.includes(view)) return;
	view.setBounds({ x: 0, y: 0, width: Math.max(1, size.width), height: Math.max(1, size.height) });
}
