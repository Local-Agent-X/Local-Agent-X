/**
 * Wire types for the browser-view message family on the server↔desktop
 * bridge (mirrored in src/browser/bridge-client.ts). Pure declarations +
 * the message-type guard — no Electron, no behavior — split from
 * server-bridge-browser.ts, which re-exports the public names so callers
 * keep one import surface.
 */

import type { Rectangle } from "electron";

export type BrowserLifecycleOp = "create" | "show" | "hide" | "close" | "setBounds" | "ping" | "list";

export type BridgeInputModifier = "shift" | "control" | "alt" | "meta";
export interface BridgeMouseEvent {
	type: "mouseDown" | "mouseUp" | "mouseMove";
	x: number;
	y: number;
	button?: "left" | "middle" | "right";
	clickCount?: number;
	modifiers?: BridgeInputModifier[];
}
export interface BridgeMouseWheelEvent {
	type: "mouseWheel";
	x: number;
	y: number;
	deltaX?: number;
	deltaY?: number;
	modifiers?: BridgeInputModifier[];
}
export interface BridgeKeyEvent {
	type: "keyDown" | "keyUp" | "char";
	keyCode: string;
	modifiers?: BridgeInputModifier[];
}
export type BridgeInputEvent = BridgeMouseEvent | BridgeMouseWheelEvent | BridgeKeyEvent;

export interface BrowserLifecycleRequest {
	type: "lax:browser-lifecycle";
	id: number;
	op: BrowserLifecycleOp;
	viewId: string;
	partition?: string;
	bounds?: Rectangle;
}
export interface BrowserNavigateRequest { type: "lax:browser-navigate"; id: number; viewId: string; url: string; timeoutMs?: number }
export interface BrowserExecRequest { type: "lax:browser-exec"; id: number; viewId: string; script: string; world?: "isolated"; allFrames?: boolean }
export interface BrowserInputRequest { type: "lax:browser-input"; id: number; viewId: string; event: BridgeInputEvent }
export interface BrowserCaptureRequest { type: "lax:browser-capture"; id: number; viewId: string }
export interface BrowserClearPartitionRequest { type: "lax:browser-clear-partition"; id: number; partition: string }
export interface BrowserAbortRequest { type: "lax:browser-abort"; viewId: string }
export interface BrowserEgressAskResult { type: "lax:browser-egress-ask-result"; id: number; allowed: boolean }
export interface BrowserReadConsoleRequest { type: "lax:browser-read-console"; id: number; viewId: string }
export interface BrowserReadNetworkRequest { type: "lax:browser-read-network"; id: number; viewId: string }

export type BrowserBridgeMessage =
	| BrowserLifecycleRequest
	| BrowserNavigateRequest
	| BrowserExecRequest
	| BrowserInputRequest
	| BrowserCaptureRequest
	| BrowserClearPartitionRequest
	| BrowserAbortRequest
	| BrowserEgressAskResult
	| BrowserReadConsoleRequest
	| BrowserReadNetworkRequest;

const BROWSER_MESSAGE_TYPES = new Set<string>([
	"lax:browser-lifecycle",
	"lax:browser-navigate",
	"lax:browser-exec",
	"lax:browser-input",
	"lax:browser-capture",
	"lax:browser-clear-partition",
	"lax:browser-abort",
	"lax:browser-egress-ask-result",
	"lax:browser-read-console",
	"lax:browser-read-network",
]);

export function isBrowserBridgeMessage(msg: { type?: string }): msg is BrowserBridgeMessage {
	return typeof msg?.type === "string" && BROWSER_MESSAGE_TYPES.has(msg.type);
}
