/**
 * Agent input routing — the 2026-07-25 "it's highlighting things outside the
 * browser view" class.
 *
 * Mouse events carry coordinates and always land in the view they are sent to.
 * KEY events do not: they go to whatever widget currently holds focus. This app
 * moves focus between the native view and the renderer by design (see
 * browser-page-controls.ts, which focuses the renderer for the find bar; the
 * user clicking the chat box does the same). So whenever focus sat in the
 * renderer, the agent's keystrokes went to the app's own UI — a fill's
 * select-all chord highlighted the whole app window, and the characters after
 * it were typed into the app instead of the field.
 */
import { describe, expect, it } from "vitest";
import type { WebContents } from "electron";
import { dispatchAgentInput, isMouseEvent, toElectronInputEvent } from "./browser-agent-input";
import type { BridgeInputEvent } from "./server-bridge-browser-wire";

function recorder() {
	const calls: string[] = [];
	const wc = {
		focus: () => { calls.push("focus"); },
		sendInputEvent: (e: { type: string }) => { calls.push(`send:${e.type}`); },
	} as unknown as WebContents;
	return { wc, calls };
}

function dispatch(ev: BridgeInputEvent) {
	const { wc, calls } = recorder();
	const cursor: Array<[number, number]> = [];
	const event = toElectronInputEvent(ev);
	if (!event) throw new Error(`unsupported ${ev.type}`);
	dispatchAgentInput(wc, event, (x, y) => cursor.push([x, y]));
	return { calls, cursor };
}

describe("agent input focus routing", () => {
	it("claims focus for the view BEFORE dispatching a key event", () => {
		// The select-all chord that opens every fill: if it lands anywhere but
		// the page, it selects that whole document instead.
		const { calls } = dispatch({ type: "keyDown", keyCode: "a", modifiers: ["control"] });
		expect(calls).toEqual(["focus", "send:keyDown"]);
	});

	it("claims focus for typed characters too — they must not reach the app's chat box", () => {
		expect(dispatch({ type: "char", keyCode: "4" }).calls).toEqual(["focus", "send:char"]);
	});

	it("does NOT steal focus for mouse events — coordinates already target the view", () => {
		// Grabbing focus on every mouseMove would fight the user for the caret
		// while co-driving.
		expect(dispatch({ type: "mouseMove", x: 10, y: 20 }).calls).toEqual(["send:mouseMove"]);
		expect(dispatch({ type: "mouseDown", x: 10, y: 20, button: "left", clickCount: 1 }).calls)
			.toEqual(["send:mouseDown"]);
		expect(dispatch({ type: "mouseWheel", x: 1, y: 2, deltaX: 0, deltaY: 40 }).calls)
			.toEqual(["send:mouseWheel"]);
	});

	it("draws the agent cursor for mouse events only, at the event's point", () => {
		expect(dispatch({ type: "mouseDown", x: 33, y: 44, button: "left", clickCount: 1 }).cursor).toEqual([[33, 44]]);
		expect(dispatch({ type: "keyDown", keyCode: "a" }).cursor).toEqual([]);
	});
});

describe("toElectronInputEvent", () => {
	it("translates each dispatchable type and rejects the rest", () => {
		expect(toElectronInputEvent({ type: "keyUp", keyCode: "Delete" })).toEqual({
			type: "keyUp", keyCode: "Delete", modifiers: undefined,
		});
		expect(isMouseEvent(toElectronInputEvent({ type: "mouseUp", x: 1, y: 2 })!)).toBe(true);
		expect(isMouseEvent(toElectronInputEvent({ type: "char", keyCode: "z" })!)).toBe(false);
		expect(toElectronInputEvent({ type: "levitate" } as unknown as BridgeInputEvent)).toBeNull();
	});
});
