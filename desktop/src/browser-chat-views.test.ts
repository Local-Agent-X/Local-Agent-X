// The browser pane belongs to the chat on screen (2026-11-22): each chat has
// its own home view, its own user tabs and its own "what the pane was showing",
// and a chat that is not on screen never changes what is.
import { beforeEach, describe, expect, it } from "vitest";
import {
	boundChat,
	claimUnownedViews,
	claimUserView,
	currentViewId,
	forgetView,
	homeViewId,
	isHomeViewId,
	noteBackgroundAgentView,
	setBoundChat,
	setCurrentViewId,
	shownInBoundChat,
	userViewOwner,
	viewChat,
	_resetBrowserChatViewsForTest,
} from "./browser-chat-views";

beforeEach(() => _resetBrowserChatViewsForTest());

describe("each chat has its own pane", () => {
	it("a chat starts on its own home view; no chat is the old foreground view", () => {
		expect(currentViewId()).toBe("foreground");
		setBoundChat("chat-a");
		expect(boundChat()).toBe("chat-a");
		expect(currentViewId()).toBe("home-chat-a");
		expect(homeViewId("chat-b")).toBe("home-chat-b");
		expect([isHomeViewId("foreground"), isHomeViewId("home-chat-a"), isHomeViewId("user-3"), isHomeViewId("view-chat-a-shared")]).toEqual([true, true, false, false]);
	});

	it("remembers what each chat's pane was showing and restores it", () => {
		setBoundChat("chat-a");
		setCurrentViewId("user-1");
		setBoundChat("chat-b");
		expect(currentViewId()).toBe("home-chat-b");
		setCurrentViewId("view-chat-b-shared");
		setBoundChat("chat-a");
		expect(currentViewId()).toBe("user-1");
		setBoundChat("chat-b");
		expect(currentViewId()).toBe("view-chat-b-shared");
	});

	it("a closed view sends the chat that was on it back to its home view", () => {
		setBoundChat("chat-a");
		claimUserView("user-1");
		setCurrentViewId("user-1");
		forgetView("user-1");
		expect(currentViewId()).toBe("home-chat-a");
		expect(userViewOwner("user-1")).toBeUndefined();
	});
});

describe("which chat a view belongs to", () => {
	it("a user tab belongs to the chat on screen when it was opened", () => {
		setBoundChat("chat-a");
		claimUserView("user-1");
		setBoundChat("chat-b");
		claimUserView("user-2");
		expect([userViewOwner("user-1"), userViewOwner("user-2")]).toEqual(["chat-a", "chat-b"]);
		expect(viewChat("user-1", false)).toBe("chat-a");
	});

	it("an agent view belongs to the session its id names, hyphens and tab numbers included", () => {
		expect(viewChat("view-chat-a-shared", true)).toBe("chat-a");
		expect(viewChat("view-fork-89dc-shared-t3", true)).toBe("fork-89dc");
		expect(viewChat("view-odd", true)).toBeUndefined();
	});

	it("the tab strip lists the chat on screen's views and the ones that belong to none", () => {
		setBoundChat("chat-a");
		claimUserView("user-1");
		setBoundChat("chat-b");
		claimUserView("user-2");
		const shown = (id: string, agent: boolean) => shownInBoundChat(id, agent);
		expect([shown("user-1", false), shown("user-2", false), shown("view-chat-a-shared", true), shown("view-chat-b-shared-t2", true), shown("user-9", false)])
			.toEqual([false, true, false, true, true]);
	});

	it("with no chat on screen a new tab belongs to none, and the next chat takes it with the pane", () => {
		claimUserView("user-1"); // no chat: stays unowned
		setCurrentViewId("user-1");
		expect(userViewOwner("user-1")).toBeUndefined();
		setBoundChat("chat-a");
		claimUnownedViews(["foreground", "user-1"], "chat-a");
		expect(userViewOwner("user-1")).toBe("chat-a");
		expect(currentViewId()).toBe("user-1");
		// A later chat finds nothing left to take.
		setBoundChat("chat-b");
		claimUnownedViews(["foreground", "user-1"], "chat-b");
		expect(userViewOwner("user-1")).toBe("chat-a");
		expect(currentViewId()).toBe("home-chat-b");
	});
});

describe("an agent browsing in a chat that is not on screen", () => {
	const holdsPage = (pages: string[]) => (current: string) => pages.includes(current);

	it("leaves the pane on screen alone and becomes what its own chat shows next", () => {
		setBoundChat("chat-a");
		setCurrentViewId("user-1");
		noteBackgroundAgentView("view-chat-b-shared", "chat-b", holdsPage([]));
		expect(currentViewId()).toBe("user-1");
		setBoundChat("chat-b");
		expect(currentViewId()).toBe("view-chat-b-shared");
	});

	it("follows the agent from its own tab to its next one", () => {
		noteBackgroundAgentView("view-chat-b-shared", "chat-b", holdsPage(["view-chat-b-shared"]));
		noteBackgroundAgentView("view-chat-b-shared-t2", "chat-b", holdsPage(["view-chat-b-shared"]));
		expect(currentViewId("chat-b")).toBe("view-chat-b-shared-t2");
	});

	it("does not replace a page the user left open in that chat, but does replace a blank one", () => {
		setBoundChat("chat-b");
		setCurrentViewId("user-7");
		setBoundChat("chat-a");
		noteBackgroundAgentView("view-chat-b-shared", "chat-b", holdsPage(["user-7"]));
		expect(currentViewId("chat-b")).toBe("user-7");
		noteBackgroundAgentView("view-chat-b-shared", "chat-b", holdsPage([]));
		expect(currentViewId("chat-b")).toBe("view-chat-b-shared");
	});
});
