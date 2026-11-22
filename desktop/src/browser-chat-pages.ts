// What happens to a chat's browser pages when the chat is not on screen, and
// when it is deleted. The rules and the record of which page rests are in
// browser-chat-views.ts (no electron); this is the half that touches the view
// pool: closing a view to rest it, making it anew to wake it, and closing
// every view of a chat that is gone.
import type { WebContentsView } from "electron";

import { prepareEmbeddedChromeIdentityForNavigation } from "./embedded-chrome-identity";
import { closeBrowserView, createBrowserView, getAttachedViewId, getBrowserView, isViewAdopted, listBrowserViews } from "./browser-views";
import { forgetChat, pagesToRest, restView, viewChat, wakeRested } from "./browser-chat-views";
import { emitAgentViewClosed } from "./browser-perception";
import { SHARED_BROWSER_PARTITION } from "./browser-partition";
import { markHumanNavigation } from "./in-app-browser";

/** How often the pages of chats off screen are checked for resting. */
const REST_CHECK_MS = 60_000;

/** A resting page is wanted again: make its view anew and load its address.
 *  Undefined when `viewId` is not a resting page. */
export function wakeRestedPage(viewId: string): WebContentsView | undefined {
	const record = wakeRested(viewId);
	if (!record) return undefined;
	createBrowserView(viewId, { partition: SHARED_BROWSER_PARTITION, agentDriven: false });
	const view = getBrowserView(viewId)!;
	// The person's own page coming back, as when they opened it.
	markHumanNavigation(viewId);
	void prepareEmbeddedChromeIdentityForNavigation(view.webContents)
		.then(() => view.webContents.loadURL(record.url))
		.catch(() => { /* ERR_ABORTED etc. — nav-state carries the real outcome */ });
	return view;
}

/** A page that must stay loaded: on screen, driven by an agent, or playing sound. */
function pageIsBusy(viewId: string): boolean {
	if (getAttachedViewId() === viewId || isViewAdopted(viewId)) return true;
	const wc = getBrowserView(viewId)?.webContents;
	return !!wc && !wc.isDestroyed() && wc.isCurrentlyAudible();
}

/** Put to rest the user pages of chats that have been off screen long enough
 *  (browser-chat-views.ts pagesToRest): close the view, keep the tab. */
export function restIdlePages(): void {
	const live = listBrowserViews().filter((v) => !v.agentDriven && v.url !== "" && v.url !== "about:blank");
	for (const viewId of pagesToRest(live.map((v) => v.viewId), Date.now(), pageIsBusy)) {
		const info = live.find((v) => v.viewId === viewId)!;
		restView(viewId, info.url, info.title);
		closeBrowserView(viewId);
	}
}

/** Check for pages to rest once a minute, for as long as the app runs. */
export function startPageRestTimer(): void {
	setInterval(restIdlePages, REST_CHECK_MS).unref();
}

/** A chat was deleted: close every view of it, its agent's included (the
 *  server is told, as for a tab closed from the strip), and forget the chat.
 *  The pane must already be off that chat (browser-ipc.ts bindChat). */
export function closeChatViews(chat: string): void {
	for (const info of listBrowserViews()) {
		if (viewChat(info.viewId, info.agentDriven) !== chat) continue;
		closeBrowserView(info.viewId);
		if (info.agentDriven) emitAgentViewClosed(info.viewId);
	}
	forgetChat(chat);
}
