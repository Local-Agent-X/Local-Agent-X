// The browser pane belongs to the chat on screen.
//
// One pane used to show one "current" view for the whole window, and every
// chat's tabs sat in one strip: an agent browsing in a chat the user was not
// looking at took a blank pane and turned the panel to it, and two chats'
// agents could be offered, and take over, the same user tab (2026-11-22).
//
// Here is the state that makes the pane per chat, kept apart from browser-ipc.ts
// so it is testable without electron:
//   - the chat the renderer has on screen (it says so on every chat change);
//   - which chat each USER view belongs to: the chat on screen when it was
//     opened. An agent view's id names its own session (contract/browser-view-ids);
//   - the view each chat's pane was last showing, restored when it comes back.
//
// A view that belongs to no chat (opened with no chat on screen) shows in
// every chat until a chat claims it.
//
// Every chat's pages staying loaded would only ever grow: each is a full
// renderer. So a user page of a chat that has been off screen a while is put
// to REST: its view is closed, and its tab stays in the chat's strip with its
// address and title. Showing it again loads the address fresh (the same page,
// not what was typed into it or how far it was scrolled). A page that is
// playing sound or that an agent is driving is never rested, and neither is
// anything in the chat on screen. A deleted chat's views are closed and all
// of this is forgotten for it.

import { sessionIdFromViewId } from "./contract/browser-view-ids";

/** The pane's own view with no chat on screen, as before chats owned views. */
const NO_CHAT_HOME = "foreground";
const NO_CHAT = "";

/** A chat's pages rest once it has been off screen this long. */
export const REST_AFTER_MS = 30 * 60_000;
/** Loaded pages kept across the chats off screen; past it the ones whose chat
 *  left longest ago rest at once. */
export const MAX_LIVE_BACKGROUND_PAGES = 8;

/** A user page closed to free its memory, kept as a tab of its chat. */
export interface RestedView { viewId: string; chat: string; url: string; title: string }

let bound: string | null = null;
const owners = new Map<string, string>();
const currents = new Map<string, string>();
const rested = new Map<string, RestedView>();
/** When each chat that is off screen left it. */
const leftAt = new Map<string, number>();

export function boundChat(): string | null {
	return bound;
}

export function setBoundChat(chat: string | null, now: number = Date.now()): void {
	const next = chat || null;
	if (bound && bound !== next) leftAt.set(bound, now);
	bound = next;
	if (bound) leftAt.delete(bound);
}

/** The pane's own lazily made view for a chat: what it shows before the user
 *  or the agent opens anything. */
export function homeViewId(chat: string | null = bound): string {
	return chat ? `home-${chat}` : NO_CHAT_HOME;
}

export function isHomeViewId(viewId: string): boolean {
	return viewId === NO_CHAT_HOME || viewId.startsWith("home-");
}

/** The view a chat's pane drives: the one it last showed, else its home view. */
export function currentViewId(chat: string | null = bound): string {
	return currents.get(chat ?? NO_CHAT) ?? homeViewId(chat);
}

export function setCurrentViewId(viewId: string, chat: string | null = bound): void {
	currents.set(chat ?? NO_CHAT, viewId);
}

/** Record that a user view belongs to a chat. With no chat it stays unowned. */
export function claimUserView(viewId: string, chat: string | null = bound): void {
	if (chat) owners.set(viewId, chat);
}

export function userViewOwner(viewId: string): string | undefined {
	return owners.get(viewId);
}

/** The chat a view belongs to, or undefined when it belongs to none. */
export function viewChat(viewId: string, agentDriven: boolean): string | undefined {
	return agentDriven ? sessionIdFromViewId(viewId) : owners.get(viewId);
}

/** Whether the pane and its tab strip list this view for the chat on screen. */
export function shownInBoundChat(viewId: string, agentDriven: boolean): boolean {
	const chat = viewChat(viewId, agentDriven);
	return !chat || chat === bound;
}

/** A view is gone: drop its owner, and any chat whose pane was on it falls
 *  back to its home view. */
export function forgetView(viewId: string): void {
	owners.delete(viewId);
	rested.delete(viewId);
	for (const [chat, current] of currents) if (current === viewId) currents.delete(chat);
}

/** A chat is gone: nothing of it is remembered. Its views are the caller's to close. */
export function forgetChat(chat: string): void {
	for (const [viewId, owner] of owners) if (owner === chat) owners.delete(viewId);
	for (const [viewId, record] of rested) if (record.chat === chat) rested.delete(viewId);
	currents.delete(chat);
	leftAt.delete(chat);
	if (bound === chat) bound = null;
}

/**
 * The loaded user pages to rest now, out of `pages` (live user views showing
 * a real page). `busy` says a page must stay loaded: it is playing sound, or
 * an agent is driving it. A page rests when its chat has been off screen for
 * REST_AFTER_MS, or sooner when more than MAX_LIVE_BACKGROUND_PAGES are held:
 * then the ones whose chat left longest ago go first.
 */
export function pagesToRest(pages: string[], now: number, busy: (viewId: string) => boolean): string[] {
	const candidates = pages
		.map((viewId) => ({ viewId, chat: owners.get(viewId) }))
		.filter((page) => page.chat !== undefined && page.chat !== bound && !busy(page.viewId))
		.map((page) => ({ viewId: page.viewId, left: leftAt.get(page.chat as string) ?? now }))
		.sort((a, b) => a.left - b.left);
	const overCap = Math.max(0, candidates.length - MAX_LIVE_BACKGROUND_PAGES);
	return candidates.filter((page, i) => i < overCap || now - page.left >= REST_AFTER_MS).map((page) => page.viewId);
}

/** Record a page as resting. Its owner and its place as its chat's current
 *  view are kept: closing its view is the caller's. */
export function restView(viewId: string, url: string, title: string): void {
	const chat = owners.get(viewId);
	if (chat) rested.set(viewId, { viewId, chat, url, title });
}

/** A resting page is about to be shown: its record, which is dropped. */
export function wakeRested(viewId: string): RestedView | undefined {
	const record = rested.get(viewId);
	rested.delete(viewId);
	return record;
}

export function isRested(viewId: string): boolean {
	return rested.has(viewId);
}

/** A chat's resting pages, for its tab strip. */
export function restedViewsOf(chat: string | null = bound): RestedView[] {
	return [...rested.values()].filter((record) => record.chat === chat);
}

/** The user views opened with no chat on screen now belong to `chat`, and the
 *  pane keeps the one it was showing if this chat has shown nothing yet. */
export function claimUnownedViews(userViewIds: string[], chat: string): void {
	const shownWithNoChat = currents.get(NO_CHAT);
	for (const viewId of userViewIds) {
		if (owners.has(viewId)) continue;
		owners.set(viewId, chat);
		if (viewId === shownWithNoChat && !currents.has(chat)) currents.set(chat, viewId);
	}
	currents.delete(NO_CHAT);
}

/**
 * An agent's active view changed in a chat that is not on screen. Its pane is
 * not touched; the view becomes what that chat's pane shows when the user
 * comes back, unless the pane was left on a page the user put there.
 * `paneHoldsUserPage` answers that for the chat's current view.
 */
export function noteBackgroundAgentView(viewId: string, chat: string, paneHoldsUserPage: (current: string) => boolean): void {
	const current = currents.get(chat);
	if (current && sessionIdFromViewId(current) !== chat && paneHoldsUserPage(current)) return;
	currents.set(chat, viewId);
}

/** Test seam. */
export function _resetBrowserChatViewsForTest(): void {
	bound = null;
	owners.clear();
	currents.clear();
	rested.clear();
	leftAt.clear();
}
