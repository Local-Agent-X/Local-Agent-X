/**
 * Local Agent X — Browser chat overlay
 *
 * The floating chat surface drawn ABOVE the attached browser view: its own
 * WebContentsView on the app's own origin, stacked into the main window on
 * top of whichever pool view is currently attached.
 *
 * Split out of browser-views.ts (which sits at the 400-LOC ceiling, same
 * reason as the browser-ipc → browser-page-controls split). The overlay is
 * its own responsibility, but its LIFETIME is coupled to the attached view:
 * it is added on attach, removed on detach, and never shown while nothing is
 * attached. The pool owns `attachedId` and passes it in on every call — this
 * module never reaches back into the pool, so the two never co-own it.
 */

import { shell, WebContentsView, type Rectangle } from "electron";
import { join } from "path";

import { getMainWindow } from "./window";

export interface BrowserChatOverlayState {
	sessionId: string | null;
	collapsed: boolean;
	latestOpen: boolean;
}

let chatOverlayView: WebContentsView | null = null;
let chatOverlayBounds: Rectangle | null = null;
let chatOverlayState: BrowserChatOverlayState | null = null;
let chatOverlayLoaded = false;
let chatOverlayUrl: string | null = null;
let chatOverlayViewUrl: string | null = null;

function sendChatOverlayState(): void {
	if (!chatOverlayLoaded || !chatOverlayView || !chatOverlayState) return;
	chatOverlayView.webContents.send("browser-chat-overlay-state", chatOverlayState);
}

function ensureChatOverlayView(url: string): WebContentsView {
	if (chatOverlayView && !chatOverlayView.webContents.isDestroyed() && chatOverlayViewUrl === url) {
		return chatOverlayView;
	}
	if (chatOverlayView && !chatOverlayView.webContents.isDestroyed()) {
		detachChatOverlay();
		chatOverlayView.webContents.close();
	}
	const origin = new URL(url).origin;
	const view = new WebContentsView({
		webPreferences: {
			preload: join(__dirname, "preload.js"),
			contextIsolation: true,
			nodeIntegration: false,
			sandbox: true,
			spellcheck: true,
		},
	});
	view.setBackgroundColor("#00000000");
	view.setBorderRadius(14);
	view.webContents.setWindowOpenHandler(({ url }) => {
		const target = new URL(url);
		if ((target.protocol === "http:" || target.protocol === "https:") && target.origin !== origin) {
			void shell.openExternal(url);
		}
		return { action: "deny" };
	});
	view.webContents.on("will-navigate", (event, url) => {
		if (new URL(url).origin !== origin) event.preventDefault();
	});
	view.webContents.on("did-finish-load", () => {
		chatOverlayLoaded = true;
		sendChatOverlayState();
	});
	chatOverlayView = view;
	chatOverlayLoaded = false;
	chatOverlayViewUrl = url;
	void view.webContents.loadURL(url).catch(() => {});
	return view;
}

/** Stack the overlay onto the window. `attachedViewId` is the pool's current
 *  attachment — null means nothing is attached, so there is nothing to float
 *  above and the call is a no-op. */
export function attachChatOverlay(attachedViewId: string | null): void {
	if (!chatOverlayBounds || !chatOverlayState || !chatOverlayUrl || !attachedViewId) return;
	const win = getMainWindow();
	if (!win || win.isDestroyed()) return;
	const view = ensureChatOverlayView(chatOverlayUrl);
	view.setBounds(chatOverlayBounds);
	win.contentView.addChildView(view);
	sendChatOverlayState();
}

export function detachChatOverlay(): void {
	if (!chatOverlayView) return;
	const win = getMainWindow();
	if (win && !win.isDestroyed()) win.contentView.removeChildView(chatOverlayView);
}

/** Apply the renderer's overlay report (rect + state + origin URL). Clearing
 *  either the bounds or the state takes the overlay down. */
export function applyChatOverlay(
	bounds: Rectangle | null,
	state: BrowserChatOverlayState | null,
	url: string | null,
	attachedViewId: string | null,
): void {
	chatOverlayBounds = bounds;
	chatOverlayState = state;
	if (url) chatOverlayUrl = url;
	if (!bounds || !state) {
		detachChatOverlay();
		return;
	}
	attachChatOverlay(attachedViewId);
}
