/**
 * Agent input translation and routing for a browser view — the bridge's
 * "lax:browser-input" body, split out of server-bridge-browser.ts because
 * delivering synthetic input correctly is its own concern.
 *
 * The rule: agent input never moves OS focus. The user types into the chat
 * while the agent works (to steer it mid-task), and every focus grab took
 * the caret out of the chat box mid-word (2026-11-23).
 *
 *   MOUSE events carry coordinates and land in the view they are sent to.
 *
 *   KEY events reach the view's page without focus too: sendInputEvent
 *   forwards them to this webContents' own renderer, whoever holds focus.
 *   What focus used to buy is supplied without it:
 *
 *   - The page must behave as focused: an unfocused page fires no focus or
 *     blur events, so a form that validates or formats on blur never would.
 *     CDP focus emulation makes the page act focused (and survives
 *     navigation) while OS focus stays where the user put it.
 *
 *   - A key the page leaves unhandled falls through to the app menu, whose
 *     edit roles act on the FOCUSED webContents: the agent's Ctrl+Z on a page
 *     with no field focused undid the user's typing in the chat, and its
 *     select-all once highlighted the entire app window (2026-07-25, the Thrive
 *     PO form). So the view ignores menu shortcuts while the agent types; the
 *     user's next real input in the view hands them back (in-app-browser.ts),
 *     before that input reaches the menu.
 *
 *   - On macOS the renderer leaves Cmd+A/C/X/V/Z to the Edit menu, so with
 *     the menu out of the way they would do nothing. The view's own edit
 *     command runs instead, what the menu would have run on a focused view.
 */

import type { KeyboardInputEvent, MouseInputEvent, MouseWheelInputEvent, WebContents } from "electron";
import type { BridgeInputEvent } from "./contract/browser-bridge.js";

type ElectronInputEvent = MouseInputEvent | MouseWheelInputEvent | KeyboardInputEvent;

/** Wire event → Electron event. null for a type we don't dispatch. */
export function toElectronInputEvent(ev: BridgeInputEvent): ElectronInputEvent | null {
	switch (ev.type) {
		case "mouseDown":
		case "mouseUp":
		case "mouseMove":
			return { type: ev.type, x: ev.x, y: ev.y, button: ev.button, clickCount: ev.clickCount, modifiers: ev.modifiers };
		case "mouseWheel":
			return { type: "mouseWheel", x: ev.x, y: ev.y, deltaX: ev.deltaX, deltaY: ev.deltaY, modifiers: ev.modifiers };
		case "keyDown":
		case "keyUp":
		case "char":
			return { type: ev.type, keyCode: ev.keyCode, modifiers: ev.modifiers };
		default:
			return null;
	}
}

export function isMouseEvent(event: ElectronInputEvent): event is MouseInputEvent | MouseWheelInputEvent {
	return event.type === "mouseDown" || event.type === "mouseUp"
		|| event.type === "mouseMove" || event.type === "mouseWheel";
}

type EditCommand = "selectAll" | "copy" | "cut" | "paste" | "undo" | "redo";

/** The Edit-menu command a macOS Cmd chord stands for, or null. Only a bare
 *  Cmd (Shift only for redo) — any other chord is the page's to handle. */
export function macEditCommand(event: KeyboardInputEvent): EditCommand | null {
	if (event.type !== "keyDown") return null;
	const mods = new Set((event.modifiers ?? []).map((m) => m.toLowerCase()));
	const cmd = mods.has("meta") || mods.has("cmd") || mods.has("command");
	if (!cmd || mods.has("control") || mods.has("ctrl") || mods.has("alt") || mods.has("option")) return null;
	const shift = mods.has("shift");
	switch (event.keyCode.toLowerCase()) {
		case "a": return shift ? null : "selectAll";
		case "c": return shift ? null : "copy";
		case "x": return shift ? null : "cut";
		case "v": return shift ? null : "paste";
		case "z": return shift ? "redo" : "undo";
		default: return null;
	}
}

const focusEmulated = new WeakSet<WebContents>();

/** Make the page behave as focused without taking OS focus. Once per
 *  webContents; a failure only costs focus/blur fidelity, never the input. */
function emulatePageFocus(wc: WebContents): void {
	if (focusEmulated.has(wc)) return;
	focusEmulated.add(wc);
	try {
		// Emulation lives on the debugger session: a detach (DevTools) drops it.
		wc.debugger.once("detach", () => focusEmulated.delete(wc));
		if (!wc.debugger.isAttached()) wc.debugger.attach("1.3");
		void wc.debugger.sendCommand("Emulation.setFocusEmulationEnabled", { enabled: true })
			.catch(() => { focusEmulated.delete(wc); });
	} catch {
		focusEmulated.delete(wc); // attach refused (another debugger holds it): retry on the next input
	}
}

/** The user acted in the view: its menu shortcuts are theirs again. */
export function handBackMenuShortcuts(wc: WebContents): void {
	if (!wc.isDestroyed()) wc.setIgnoreMenuShortcuts(false);
}

/**
 * Deliver one agent input event to `wc` without moving OS focus. `onMouse`
 * draws the agent cursor (fire-and-forget; it must never block input).
 */
export function dispatchAgentInput(
	wc: WebContents,
	event: ElectronInputEvent,
	onMouse: (x: number, y: number) => void,
	platform: NodeJS.Platform = process.platform,
): void {
	emulatePageFocus(wc);
	if (isMouseEvent(event)) {
		onMouse(event.x, event.y);
		wc.sendInputEvent(event);
		return;
	}
	wc.setIgnoreMenuShortcuts(true);
	wc.sendInputEvent(event);
	const command = platform === "darwin" ? macEditCommand(event) : null;
	if (command) wc[command]();
}

/** One real left click at view-DIP (x, y): move, down, up. The same three
 *  events the server sends one by one for a click, for a desktop-side caller
 *  that must click and listen in one breath (the upload's chooser intercept). */
export function dispatchAgentClick(wc: WebContents, x: number, y: number, onMouse: (x: number, y: number) => void): void {
	const events: ElectronInputEvent[] = [
		{ type: "mouseMove", x, y },
		{ type: "mouseDown", x, y, button: "left", clickCount: 1 },
		{ type: "mouseUp", x, y, button: "left", clickCount: 1 },
	];
	for (const event of events) dispatchAgentInput(wc, event, onMouse);
}
