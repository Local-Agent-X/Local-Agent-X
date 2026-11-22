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

import { sessionIdFromViewId } from "./contract/browser-view-ids";

/** The pane's own view with no chat on screen, as before chats owned views. */
const NO_CHAT_HOME = "foreground";
const NO_CHAT = "";

let bound: string | null = null;
const owners = new Map<string, string>();
const currents = new Map<string, string>();

export function boundChat(): string | null {
	return bound;
}

export function setBoundChat(chat: string | null): void {
	bound = chat || null;
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
	for (const [chat, current] of currents) if (current === viewId) currents.delete(chat);
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
}
