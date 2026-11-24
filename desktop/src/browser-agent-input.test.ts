/**
 * Agent input never moves OS focus (2026-11-23): the user types into the chat
 * while the agent drives the browser, and every focus grab took the caret out
 * of the chat box mid-word.
 *
 * What focus used to buy is pinned here instead: the page still behaves as
 * focused (CDP focus emulation), a key the page leaves unhandled cannot reach
 * the app menu (whose Ctrl+Z undid the user's chat typing, and whose
 * select-all once highlighted the whole app window, 2026-07-25), and on macOS
 * the Cmd edit chords the menu would have run go to the view directly.
 */
import { describe, expect, it } from "vitest";
import type { KeyboardInputEvent, WebContents } from "electron";
import { dispatchAgentClick, dispatchAgentInput, handBackMenuShortcuts, isMouseEvent, macEditCommand, toElectronInputEvent } from "./browser-agent-input";
import type { BridgeInputEvent } from "./contract/browser-bridge.js";

function recorder(opts: { attached?: boolean; attachThrows?: boolean } = {}) {
	const calls: string[] = [];
	const detachListeners: Array<() => void> = [];
	let attached = opts.attached ?? false;
	const wc = {
		focus: () => { calls.push("focus"); },
		isDestroyed: () => false,
		sendInputEvent: (e: { type: string }) => { calls.push(`send:${e.type}`); },
		setIgnoreMenuShortcuts: (v: boolean) => { calls.push(`ignoreMenu:${v}`); },
		selectAll: () => { calls.push("selectAll"); },
		copy: () => { calls.push("copy"); },
		cut: () => { calls.push("cut"); },
		paste: () => { calls.push("paste"); },
		undo: () => { calls.push("undo"); },
		redo: () => { calls.push("redo"); },
		debugger: {
			isAttached: () => attached,
			attach: () => {
				if (opts.attachThrows) throw new Error("Another debugger is already attached");
				attached = true;
				calls.push("attach");
			},
			once: (ev: string, fn: () => void) => { if (ev === "detach") detachListeners.push(fn); },
			sendCommand: async (method: string, params: unknown) => {
				calls.push(`cdp:${method}:${JSON.stringify(params)}`);
				return {};
			},
		},
	} as unknown as WebContents;
	const detach = () => { attached = false; for (const fn of detachListeners.splice(0)) fn(); };
	return { wc, calls, detach };
}

const EMULATE = 'cdp:Emulation.setFocusEmulationEnabled:{"enabled":true}';

function dispatch(ev: BridgeInputEvent, platform: NodeJS.Platform = "win32") {
	const { wc, calls } = recorder();
	const cursor: Array<[number, number]> = [];
	const event = toElectronInputEvent(ev);
	if (!event) throw new Error(`unsupported ${ev.type}`);
	dispatchAgentInput(wc, event, (x, y) => cursor.push([x, y]), platform);
	return { calls: calls.filter((c) => c !== "attach" && c !== EMULATE), cursor };
}

describe("agent input never takes OS focus", () => {
	it("a key event is delivered without focusing the view, with the app menu set aside first", () => {
		// The select-all chord that opens every fill: unhandled, it would reach the
		// menu, whose roles act on the FOCUSED webContents — the user's chat.
		expect(dispatch({ type: "keyDown", keyCode: "a", modifiers: ["control"] }).calls)
			.toEqual(["ignoreMenu:true", "send:keyDown"]);
		expect(dispatch({ type: "char", keyCode: "4" }).calls).toEqual(["ignoreMenu:true", "send:char"]);
		expect(dispatch({ type: "keyUp", keyCode: "Delete" }).calls).toEqual(["ignoreMenu:true", "send:keyUp"]);
	});

	it("mouse events neither focus the view nor touch the menu", () => {
		expect(dispatch({ type: "mouseMove", x: 10, y: 20 }).calls).toEqual(["send:mouseMove"]);
		expect(dispatch({ type: "mouseDown", x: 10, y: 20, button: "left", clickCount: 1 }).calls)
			.toEqual(["send:mouseDown"]);
		expect(dispatch({ type: "mouseWheel", x: 1, y: 2, deltaX: 0, deltaY: 40 }).calls)
			.toEqual(["send:mouseWheel"]);
	});

	it("a whole click never focuses the view", () => {
		const { wc, calls } = recorder();
		dispatchAgentClick(wc, 5, 6, () => {});
		expect(calls).not.toContain("focus");
		expect(calls.filter((c) => c.startsWith("send:"))).toEqual(["send:mouseMove", "send:mouseDown", "send:mouseUp"]);
	});

	it("draws the agent cursor for mouse events only, at the event's point", () => {
		expect(dispatch({ type: "mouseDown", x: 33, y: 44, button: "left", clickCount: 1 }).cursor).toEqual([[33, 44]]);
		expect(dispatch({ type: "keyDown", keyCode: "a" }).cursor).toEqual([]);
	});

	it("the user's input hands the menu shortcuts back", () => {
		const { wc, calls } = recorder();
		handBackMenuShortcuts(wc);
		expect(calls).toEqual(["ignoreMenu:false"]);
	});
});

describe("the page behaves as focused without OS focus", () => {
	it("turns on CDP focus emulation once per view, attaching the debugger when needed", async () => {
		const { wc, calls } = recorder();
		dispatchAgentInput(wc, { type: "mouseMove", x: 1, y: 1 }, () => {});
		dispatchAgentInput(wc, { type: "keyDown", keyCode: "a" }, () => {});
		await Promise.resolve();
		expect(calls.filter((c) => c === EMULATE)).toHaveLength(1);
		expect(calls.indexOf("attach")).toBeLessThan(calls.indexOf(EMULATE));
	});

	it("re-applies emulation after the debugger detaches (DevTools opened)", async () => {
		const { wc, calls, detach } = recorder({ attached: true });
		dispatchAgentInput(wc, { type: "char", keyCode: "x" }, () => {});
		detach();
		dispatchAgentInput(wc, { type: "char", keyCode: "y" }, () => {});
		await Promise.resolve();
		expect(calls.filter((c) => c === EMULATE)).toHaveLength(2);
	});

	it("a refused attach still delivers the input, and is retried on the next event", () => {
		const { wc, calls } = recorder({ attachThrows: true });
		dispatchAgentInput(wc, { type: "char", keyCode: "x" }, () => {});
		dispatchAgentInput(wc, { type: "char", keyCode: "y" }, () => {});
		expect(calls).toEqual(["ignoreMenu:true", "send:char", "ignoreMenu:true", "send:char"]);
	});
});

describe("macOS edit chords run on the view, not through the menu", () => {
	it("Cmd+A after the key event selects all in the view on darwin", () => {
		expect(dispatch({ type: "keyDown", keyCode: "a", modifiers: ["meta"] }, "darwin").calls)
			.toEqual(["ignoreMenu:true", "send:keyDown", "selectAll"]);
	});

	it("Windows and Linux leave the chord to the renderer, which handles Ctrl+A itself", () => {
		expect(dispatch({ type: "keyDown", keyCode: "a", modifiers: ["meta"] }, "win32").calls)
			.toEqual(["ignoreMenu:true", "send:keyDown"]);
		expect(dispatch({ type: "keyDown", keyCode: "a", modifiers: ["control"] }, "linux").calls)
			.toEqual(["ignoreMenu:true", "send:keyDown"]);
	});

	it("maps each Edit-menu chord, and nothing else", () => {
		const cmd = (keyCode: string, modifiers: string[], type: KeyboardInputEvent["type"] = "keyDown") =>
			macEditCommand({ type, keyCode, modifiers } as KeyboardInputEvent);
		expect(cmd("a", ["meta"])).toBe("selectAll");
		expect(cmd("A", ["cmd"])).toBe("selectAll");
		expect(cmd("c", ["meta"])).toBe("copy");
		expect(cmd("x", ["meta"])).toBe("cut");
		expect(cmd("v", ["meta"])).toBe("paste");
		expect(cmd("z", ["meta"])).toBe("undo");
		expect(cmd("z", ["meta", "shift"])).toBe("redo");
		expect(cmd("a", ["meta"], "keyUp")).toBeNull(); // the press runs it, not the release
		expect(cmd("a", ["control"])).toBeNull();
		expect(cmd("a", ["meta", "alt"])).toBeNull();
		expect(cmd("v", ["meta", "shift"])).toBeNull();
		expect(cmd("s", ["meta"])).toBeNull();
		expect(cmd("a", [])).toBeNull();
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
