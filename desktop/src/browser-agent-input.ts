/**
 * Agent input translation and routing for a browser view — the bridge's
 * "lax:browser-input" body, split out of server-bridge-browser.ts (400-LOC
 * gate) because delivering synthetic input correctly is its own concern.
 *
 * The routing rule is the whole reason this file exists:
 *
 *   MOUSE events carry coordinates, so they always land in the view they are
 *   sent to. KEY events do not — they go to whatever widget currently holds
 *   FOCUS. This app moves focus between the native view and the renderer by
 *   design (browser-page-controls.ts focuses the renderer for the find bar,
 *   and the user clicking the chat box does the same). So whenever focus sat
 *   in the renderer, the agent's keystrokes went to the app's own UI instead
 *   of the page: a fill's select-all chord highlighted the entire app window,
 *   and the characters after it were typed into the app rather than the field
 *   (observed 2026-07-25 driving the Thrive PO form).
 *
 * So a key event claims focus for the view first. A mouse event must NOT —
 * it does not need to, and grabbing focus on every mouseMove would fight the
 * user for the caret during co-driving.
 */

import type { KeyboardInputEvent, MouseInputEvent, MouseWheelInputEvent, WebContents } from "electron";
import type { BridgeInputEvent } from "./server-bridge-browser-wire";

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

/**
 * Deliver one agent input event to `wc`. `onMouse` draws the agent cursor
 * (fire-and-forget; it must never block input).
 */
export function dispatchAgentInput(
	wc: WebContents,
	event: ElectronInputEvent,
	onMouse: (x: number, y: number) => void,
): void {
	if (isMouseEvent(event)) onMouse(event.x, event.y);
	else wc.focus(); // keys follow focus — see the routing rule above
	wc.sendInputEvent(event);
}
