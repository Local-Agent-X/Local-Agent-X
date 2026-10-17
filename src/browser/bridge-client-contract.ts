// The server side's constants and errors for the browser bridge. The wire
// types themselves are the desktop↔server contract (src/desktop-contract/
// browser-bridge.ts); they are re-exported here so bridge-client's importers
// keep one import surface.

import { BROWSER_RESULT_TYPES } from "../desktop-contract/browser-bridge.js";

export type {
	BridgeConsoleEntry, BridgeInputEvent, BridgeInputModifier, BridgeKeyEvent, BridgeMouseEvent,
	BridgeMouseWheelEvent, BridgeNetworkEntry, BridgePingResult, BridgeRect, BridgeReply,
	BrowserLifecycleOp, BrowserViewInfo, InAppDialogSummary,
} from "../desktop-contract/browser-bridge.js";

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

import type { BridgePingResult, BrowserViewInfo } from "../desktop-contract/browser-bridge.js";

export interface BrowserLifecycleResult {
	view?: BrowserViewInfo;
	views?: BrowserViewInfo[];
	ping?: BridgePingResult;
}
export interface BrowserNavigateResult { url: string; title: string; status?: number }
export interface UserActiveResult { userActive: true }
export type BrowserInputResult = UserActiveResult | undefined;

export const RESULT_TYPES: ReadonlySet<string> = new Set(BROWSER_RESULT_TYPES);

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
/** The whole action ran out of budget, not one op. Says so in those words:
 *  the model's move after this is a different approach, not a retry of the
 *  same call, which is what a per-op "timed out after 10000ms" invited. */
export class BridgeDeadlineError extends Error {
	constructor(op: string, viewId: string, label: string, elapsedMs: number) {
		super(
			`browser ${label} ran out of time after ${Math.round(elapsedMs / 1000)}s while waiting on ${op} ` +
			`(viewId=${viewId}). The desktop browser is not responding — retrying this action will fail the same way. ` +
			`Check the pane is open, or work from the page text you already have.`,
		);
		this.name = "BridgeDeadlineError";
	}
}
