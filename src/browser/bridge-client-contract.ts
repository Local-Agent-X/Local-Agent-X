import type { BridgeConsoleEntry, BridgeNetworkEntry } from "./bridge-perception.js";

// navigate: the desktop enforces its own load deadline (sent in the message);
// the client waits that plus a reply grace — 28s ceiling, under the tool wedge.
export const LIFECYCLE_TIMEOUT_MS = 8_000;
export const NAVIGATE_DESKTOP_TIMEOUT_MS = 25_000;
export const NAVIGATE_REPLY_GRACE_MS = 3_000;
export const EXEC_TIMEOUT_MS = 10_000;
export const INPUT_TIMEOUT_MS = 5_000;
export const CAPTURE_TIMEOUT_MS = 10_000;
// Blanking every partition view before clearing storage needs a longer ceiling.
export const CLEAR_PARTITION_TIMEOUT_MS = 12_000;

export interface BridgeRect { x: number; y: number; width: number; height: number }
export interface BrowserViewInfo {
	viewId: string;
	partition: string;
	url: string;
	title: string;
	attached: boolean;
	agentDriven: boolean;
}
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
export interface BrowserLifecycleResult {
	view?: BrowserViewInfo;
	views?: BrowserViewInfo[];
	ping?: BridgePingResult;
}
/** Ping payload: liveness + url/title + the view's real layout bounds (the
 *  in-app viewportSize source — see in-app-observe.ts). */
export interface BridgePingResult {
	ok: boolean;
	url?: string;
	title?: string;
	userActive?: boolean;
	bounds?: { width: number; height: number };
}
export interface BrowserNavigateResult { url: string; title: string; status?: number }
export interface UserActiveResult { userActive: true }
export type BrowserInputResult = UserActiveResult | undefined;
export interface InAppDialogSummary { type: string; message: string }

export interface BridgeReply {
	type: string;
	id: number;
	ok: boolean;
	error?: string;
	view?: BrowserViewInfo;
	views?: BrowserViewInfo[];
	ping?: BridgePingResult;
	url?: string;
	title?: string;
	result?: unknown;
	pngB64?: string;
	allowed?: boolean;
	userActive?: boolean;
	status?: number;
	entries?: BridgeConsoleEntry[];
	network?: { entries: BridgeNetworkEntry[]; inFlight: number };
	dialogs?: InAppDialogSummary[];
	handled?: InAppDialogSummary | null;
}

export const RESULT_TYPES = new Set([
	"lax:browser-lifecycle-result", "lax:browser-navigate-result",
	"lax:browser-exec-result", "lax:browser-input-result",
	"lax:browser-capture-result", "lax:browser-clear-partition-result",
	"lax:browser-read-console-result", "lax:browser-read-network-result",
	"lax:browser-dialogs-result",
]);

export class BridgeUnavailableError extends Error {
	constructor(op: string) {
		super(`browser bridge unavailable for ${op} — not running under the desktop app`);
		this.name = "BridgeUnavailableError";
	}
}
export class BridgeTimeoutError extends Error {
	constructor(op: string, viewId: string, timeoutMs: number) {
		super(`browser ${op} timed out after ${timeoutMs}ms (viewId=${viewId})`);
		this.name = "BridgeTimeoutError";
	}
}
export class BridgeOpError extends Error {
	constructor(op: string, viewId: string, detail: string) {
		super(`browser ${op} failed (viewId=${viewId}): ${detail}`);
		this.name = "BridgeOpError";
	}
}
export class BridgeViewClosedError extends Error {
	constructor(op: string, viewId: string) {
		super(`browser ${op} cancelled — view "${viewId}" was closed`);
		this.name = "BridgeViewClosedError";
	}
}
