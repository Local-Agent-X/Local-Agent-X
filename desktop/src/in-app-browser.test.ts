/**
 * The co-drive observer hands the app menu's shortcuts back to the user.
 *
 * The agent's typing sets a view's menu shortcuts aside (browser-agent-input.ts)
 * so its unhandled chords cannot act on the user's chat. The user's own next
 * deliberate input in the view must get them back — on macOS that is their
 * Cmd+C / Cmd+V in the page — while the agent's own input echoes must not.
 */
import { describe, expect, it } from "vitest";
import type { WebContents } from "electron";
import { armCoDrive, markAgentInput } from "./in-app-browser";

function fakeView() {
	const handlers = new Map<string, (...args: unknown[]) => void>();
	const menu: boolean[] = [];
	const wc = {
		on: (ev: string, fn: (...args: unknown[]) => void) => { handlers.set(ev, fn); },
		once: () => {},
		isDestroyed: () => false,
		setIgnoreMenuShortcuts: (v: boolean) => { menu.push(v); },
	} as unknown as WebContents;
	const input = (type: string) => handlers.get("input-event")!({}, { type });
	return { wc, menu, input };
}

describe("menu shortcuts after agent typing", () => {
	it("the agent's own input echo keeps them set aside", () => {
		const { wc, menu, input } = fakeView();
		armCoDrive("v-agent-echo", wc);
		markAgentInput("v-agent-echo");
		input("keyDown");
		expect(menu).toEqual([]);
	});

	it("the user's key or click in the view hands them back", () => {
		const { wc, menu, input } = fakeView();
		armCoDrive("v-user-key", wc);
		input("rawKeyDown");
		input("mouseDown");
		expect(menu).toEqual([false, false]);
	});

	it("a hover crossing the view is not the user taking over", () => {
		const { wc, menu, input } = fakeView();
		armCoDrive("v-hover", wc);
		input("mouseMove");
		expect(menu).toEqual([]);
	});
});
