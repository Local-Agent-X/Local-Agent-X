// The browser pane belongs to the chat on screen (2026-11-22): each chat has
// its own home view, its own user tabs and its own "what the pane was showing",
// and a chat that is not on screen never changes what is.
import { beforeEach, describe, expect, it } from "vitest";
import {
	boundChat,
	claimUnownedViews,
	claimUserView,
	currentViewId,
	forgetChat,
	forgetView,
	homeViewId,
	isHomeViewId,
	isRested,
	MAX_LIVE_BACKGROUND_PAGES,
	noteBackgroundAgentView,
	pagesToRest,
	REST_AFTER_MS,
	restedViewsOf,
	restView,
	setBoundChat,
	setCurrentViewId,
	shownInBoundChat,
	userViewOwner,
	viewChat,
	wakeRested,
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

// Every chat's pages staying loaded only ever grew. A page of a chat that has
// been off screen a while rests: its view is closed, its tab is kept, and
// showing it again loads its address.
describe("pages of chats left off screen come to rest", () => {
	const never = () => false;
	/** Open a user page in `chat`, then leave that chat for `next` at `leftAtMs`. */
	function openThenLeave(viewId: string, chat: string, next: string, leftAtMs: number): void {
		setBoundChat(chat, 0);
		claimUserView(viewId);
		setBoundChat(next, leftAtMs);
	}

	it("a page rests once its chat has been off screen long enough, never before", () => {
		openThenLeave("user-1", "chat-a", "chat-b", 1_000);
		expect(pagesToRest(["user-1"], 1_000 + REST_AFTER_MS - 1, never)).toEqual([]);
		expect(pagesToRest(["user-1"], 1_000 + REST_AFTER_MS, never)).toEqual(["user-1"]);
	});

	it("never rests a page of the chat on screen, one playing sound or one an agent is driving, or one that belongs to no chat", () => {
		openThenLeave("user-1", "chat-a", "chat-b", 0);
		claimUserView("user-2"); // chat-b's, on screen
		const longAfter = REST_AFTER_MS * 10;
		expect(pagesToRest(["user-1", "user-2", "foreground"], longAfter, never)).toEqual(["user-1"]);
		expect(pagesToRest(["user-1", "user-2"], longAfter, (id) => id === "user-1")).toEqual([]);
	});

	it("coming back to a chat before its pages rest keeps them loaded", () => {
		openThenLeave("user-1", "chat-a", "chat-b", 0);
		setBoundChat("chat-a", REST_AFTER_MS - 1);
		setBoundChat("chat-b", REST_AFTER_MS); // left again: the wait starts over
		expect(pagesToRest(["user-1"], REST_AFTER_MS * 2 - 1, never)).toEqual([]);
	});

	it("past the cap, the pages whose chat left longest ago rest at once", () => {
		const pages: string[] = [];
		for (let i = 0; i <= MAX_LIVE_BACKGROUND_PAGES + 1; i++) {
			setBoundChat(`chat-${i}`, i * 10);
			claimUserView(`user-${i}`);
			pages.push(`user-${i}`);
		}
		setBoundChat("chat-now", 1_000);
		// Two over the cap: the two chats left first lose their pages, nobody else.
		expect(pagesToRest(pages, 2_000, never)).toEqual(["user-0", "user-1"]);
	});

	it("a resting page keeps its tab, its chat and its place in the pane, and wakes with its address", () => {
		openThenLeave("user-1", "chat-a", "chat-b", 0);
		setCurrentViewId("user-1", "chat-a");
		restView("user-1", "https://docs.example/page", "Docs");
		expect(isRested("user-1")).toBe(true);
		expect(restedViewsOf("chat-a")).toEqual([{ viewId: "user-1", chat: "chat-a", url: "https://docs.example/page", title: "Docs" }]);
		expect(restedViewsOf("chat-b")).toEqual([]);
		// Back in the chat: the pane still points at the page, which wakes once.
		setBoundChat("chat-a", 10);
		expect(currentViewId()).toBe("user-1");
		expect(wakeRested("user-1")).toMatchObject({ url: "https://docs.example/page" });
		expect(wakeRested("user-1")).toBeUndefined();
		expect(userViewOwner("user-1")).toBe("chat-a");
	});

	it("closing a resting tab forgets it", () => {
		openThenLeave("user-1", "chat-a", "chat-b", 0);
		restView("user-1", "https://docs.example/page", "Docs");
		forgetView("user-1");
		expect(isRested("user-1")).toBe(false);
		expect(restedViewsOf("chat-a")).toEqual([]);
	});
});

describe("a deleted chat", () => {
	it("is forgotten whole: its tabs, its resting pages, its pane", () => {
		setBoundChat("chat-a", 0);
		claimUserView("user-1");
		claimUserView("user-2");
		setCurrentViewId("user-2");
		setBoundChat("chat-b", 10);
		claimUserView("user-3");
		restView("user-1", "https://a.example/", "A");
		forgetChat("chat-a");
		expect([userViewOwner("user-1"), userViewOwner("user-2"), userViewOwner("user-3")]).toEqual([undefined, undefined, "chat-b"]);
		expect(restedViewsOf("chat-a")).toEqual([]);
		expect(currentViewId("chat-a")).toBe("home-chat-a");
		expect(boundChat()).toBe("chat-b");
	});

	it("deleted while on screen leaves no chat bound", () => {
		setBoundChat("chat-a", 0);
		forgetChat("chat-a");
		expect(boundChat()).toBeNull();
		expect(currentViewId()).toBe("foreground");
	});
});
