/**
 * Browser bridge client — server→desktop IPC for driving the pooled
 * WebContentsViews (desktop/src/browser-views.ts). Same transport and
 * correlation idiom as src/desktop-bridge.ts (seq id + pending map over
 * the parent-child IPC channel), but deliberately self-contained with
 * its OWN process.on("message") listener so desktop-bridge.ts stays
 * untouched — multiple "message" listeners coexist fine on a process.
 *
 * Also owns the REVERSE egress channel: the desktop's per-partition
 * egress guard (desktop/src/browser-partition.ts) has no policy of its
 * own — per request hop it sends "lax:browser-egress-ask" and THIS
 * listener answers from the canonical evaluateEgressForUrl, so the one
 * source of truth for URL policy never gets duplicated in Electron
 * main. Call initBrowserBridgeClient() at boot to arm that channel
 * before the first browser op.
 *
 * Fail-closed throughout: no bridge → reject; timeout → reject with a
 * typed error naming op + viewId; closing a view rejects every pending
 * op addressed to it so callers never hang out the full timeout.
 */

import { createLogger } from "../logger.js";
import { evaluateEgressForUrl } from "../security/layer/index.js";
import { getRuntimeConfig } from "../config.js";

const logger = createLogger("browser-bridge");

// ── Per-op timeouts ─────────
// navigate: the desktop enforces its own load deadline (sent in the
// message); the client waits that plus a reply grace — probeApp's
// pattern — for a 28s ceiling, under the tool wedge deadline.
export const LIFECYCLE_TIMEOUT_MS = 8_000;
export const NAVIGATE_DESKTOP_TIMEOUT_MS = 25_000;
export const NAVIGATE_REPLY_GRACE_MS = 3_000; // 25s + 3s = 28s total
export const EXEC_TIMEOUT_MS = 10_000;
export const INPUT_TIMEOUT_MS = 5_000;
export const CAPTURE_TIMEOUT_MS = 10_000;

// ── Wire types (mirrored in desktop/src/server-bridge-browser.ts) ─────────
export interface BridgeRect { x: number; y: number; width: number; height: number }

export interface BrowserViewInfo {
	viewId: string;
	partition: string;
	url: string;
	title: string;
	attached: boolean;
}

export type BrowserLifecycleOp = "create" | "show" | "hide" | "close" | "setBounds" | "ping" | "list";

/** Input shapes match Electron webContents.sendInputEvent. */
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
	// userActive: the desktop's co-drive lock reports the human is driving the
	// view. Read by the in-app backend's pre-exec arbitration before running an
	// eval-driven mutation (which bypasses the desktop input gate).
	ping?: { ok: boolean; url?: string; title?: string; userActive?: boolean };
}
export interface BrowserNavigateResult { url: string; title: string }

/** The desktop refused an agent input because the HUMAN is currently
 *  driving the view (co-drive human-priority lock). This is a STATUS the
 *  backend surfaces to the model ("user took the wheel"), not an error. */
export interface UserActiveResult { userActive: true }
/** browserInput outcome: undefined = the event was dispatched;
 *  UserActiveResult = refused, human is driving. */
export type BrowserInputResult = UserActiveResult | undefined;

export function isUserActiveResult(result: BrowserInputResult): result is UserActiveResult {
	return result?.userActive === true;
}

// Inbound reply envelope shared by every "-result" message.
interface BridgeReply {
	type: string;
	id: number;
	ok: boolean;
	error?: string;
	view?: BrowserViewInfo;
	views?: BrowserViewInfo[];
	ping?: { ok: boolean; url?: string; title?: string; userActive?: boolean };
	url?: string;
	title?: string;
	result?: unknown;
	pngB64?: string;
	allowed?: boolean;
	userActive?: boolean;
}

const RESULT_TYPES = new Set([
	"lax:browser-lifecycle-result",
	"lax:browser-navigate-result",
	"lax:browser-exec-result",
	"lax:browser-input-result",
	"lax:browser-capture-result",
]);

// ── Typed errors ─────────
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

// ── Correlation state ─────────
interface PendingOp {
	op: string;
	viewId: string;
	settle: (reply: BridgeReply) => void;
	rejectClosed: () => void;
}

let seq = 0;
const pendingOps = new Map<number, PendingOp>();
let listenerAttached = false;

export function browserBridgeAvailable(): boolean {
	return process.env.LAX_DESKTOP_BRIDGE === "1" && typeof process.send === "function";
}

/** Answer the desktop egress guard from the canonical URL policy. Any
 *  failure answers allowed:false — the guard is fail-closed on both ends. */
function answerEgressAsk(id: number, url: string): void {
	let allowed = false;
	try {
		const selfPort = process.env.LAX_PORT ?? String(getRuntimeConfig().port);
		allowed = evaluateEgressForUrl(url, selfPort).allowed === true;
	} catch (e) {
		logger.warn(`[browser-bridge] egress evaluation failed for ${url}: ${(e as Error).message}`);
		allowed = false;
	}
	try {
		process.send!({ type: "lax:browser-egress-ask-result", id, allowed });
	} catch (e) {
		logger.warn(`[browser-bridge] egress-ask reply send failed: ${(e as Error).message}`);
	}
}

function ensureListener(): void {
	if (listenerAttached) return;
	listenerAttached = true;
	process.on("message", (msg: BridgeReply & { url?: string }) => {
		if (!msg || typeof msg.type !== "string") return;
		if (msg.type === "lax:browser-egress-ask") {
			if (typeof msg.id !== "number" || typeof msg.url !== "string") return;
			answerEgressAsk(msg.id, msg.url);
			return;
		}
		if (!RESULT_TYPES.has(msg.type)) return;
		const entry = pendingOps.get(msg.id);
		if (entry) entry.settle(msg);
	});
}

/** Arm the reverse egress-ask channel (and reply correlation) without
 *  issuing an op. Wire this once at server boot when running under the
 *  desktop; harmless no-op elsewhere. */
export function initBrowserBridgeClient(): void {
	if (!browserBridgeAvailable()) return;
	ensureListener();
}

/** Reject every pending op addressed to viewId (except `exceptId`, the
 *  in-flight close itself) so callers don't hang until their timeout. */
function rejectPendingForView(viewId: string, exceptId: number): void {
	for (const [id, entry] of pendingOps) {
		if (id !== exceptId && entry.viewId === viewId) entry.rejectClosed();
	}
}

function request(
	op: string,
	viewId: string,
	message: Record<string, unknown>,
	timeoutMs: number,
): Promise<BridgeReply> {
	if (!browserBridgeAvailable()) return Promise.reject(new BridgeUnavailableError(op));
	ensureListener();
	const id = ++seq;
	return new Promise<BridgeReply>((resolve, reject) => {
		let timer: ReturnType<typeof setTimeout>;
		const finish = (fn: () => void) => { clearTimeout(timer); pendingOps.delete(id); fn(); };
		pendingOps.set(id, {
			op,
			viewId,
			settle: (reply) => finish(() => {
				// ok:false + userActive is the co-drive human-priority refusal —
				// a status outcome, and ONLY the input op is defined to carry it;
				// on any other op the flag is garbage and stays a failure.
				if (!reply.ok && !(op === "input" && reply.userActive === true)) reject(new BridgeOpError(op, viewId, reply.error ?? "unknown error"));
				else resolve(reply);
			}),
			rejectClosed: () => finish(() => reject(new BridgeViewClosedError(op, viewId))),
		});
		timer = setTimeout(() => finish(() => reject(new BridgeTimeoutError(op, viewId, timeoutMs))), timeoutMs);
		try {
			process.send!({ id, ...message });
		} catch (e) {
			finish(() => reject(new BridgeOpError(op, viewId, `send failed: ${(e as Error).message}`)));
			return;
		}
		// A close in flight means every other op on this view is doomed to
		// time out against a destroyed webContents — reject them now.
		if (op === "lifecycle:close") rejectPendingForView(viewId, id);
	});
}

// ── Public ops ─────────
export async function browserLifecycle(
	op: BrowserLifecycleOp,
	viewId: string,
	opts?: { partition?: string; bounds?: BridgeRect },
): Promise<BrowserLifecycleResult> {
	if (op === "create" && !opts?.partition) {
		throw new BridgeOpError(`lifecycle:${op}`, viewId, "create requires a partition");
	}
	const reply = await request(
		`lifecycle:${op}`,
		viewId,
		{ type: "lax:browser-lifecycle", op, viewId, partition: opts?.partition, bounds: opts?.bounds },
		LIFECYCLE_TIMEOUT_MS,
	);
	return { view: reply.view, views: reply.views, ping: reply.ping };
}

export async function browserNavigate(viewId: string, url: string): Promise<BrowserNavigateResult> {
	const reply = await request(
		"navigate",
		viewId,
		{ type: "lax:browser-navigate", viewId, url, timeoutMs: NAVIGATE_DESKTOP_TIMEOUT_MS },
		NAVIGATE_DESKTOP_TIMEOUT_MS + NAVIGATE_REPLY_GRACE_MS,
	);
	return { url: reply.url ?? "", title: reply.title ?? "" };
}

/** Runs `script` in the view's ISOLATED world (the only supported world —
 *  main-world execution is deliberately not offered by the desktop side).
 *  `allFrames: true` asks the desktop to run the script per same-origin
 *  frame and aggregate the results as an array (main frame first); frames
 *  the desktop cannot reach in an isolated world are skipped fail-closed,
 *  never executed in the main world. */
export async function browserExec(
	viewId: string,
	script: string,
	opts?: { world?: "isolated"; allFrames?: boolean },
): Promise<unknown> {
	const reply = await request(
		"exec",
		viewId,
		{
			type: "lax:browser-exec",
			viewId,
			script,
			world: opts?.world ?? "isolated",
			allFrames: opts?.allFrames === true,
		},
		EXEC_TIMEOUT_MS,
	);
	return reply.result;
}

/** Dispatch one input event. Resolves { userActive: true } — WITHOUT the
 *  event having been sent — when the human is driving the view; resolves
 *  undefined when the event was dispatched (unchanged from the B1 shape). */
export async function browserInput(viewId: string, event: BridgeInputEvent): Promise<BrowserInputResult> {
	const reply = await request(
		"input",
		viewId,
		{ type: "lax:browser-input", viewId, event },
		INPUT_TIMEOUT_MS,
	);
	return reply.userActive === true ? { userActive: true } : undefined;
}

/** Returns the view's current paint as a base64 PNG. */
export async function browserCapture(viewId: string): Promise<string> {
	const reply = await request(
		"capture",
		viewId,
		{ type: "lax:browser-capture", viewId },
		CAPTURE_TIMEOUT_MS,
	);
	if (typeof reply.pngB64 !== "string" || reply.pngB64.length === 0) {
		throw new BridgeOpError("capture", viewId, "desktop returned no image data");
	}
	return reply.pngB64;
}

/** Fire-and-forget: stop the view's in-flight load. No id, no reply. */
export function browserAbort(viewId: string): void {
	if (!browserBridgeAvailable()) return;
	try {
		process.send!({ type: "lax:browser-abort", viewId });
	} catch (e) {
		logger.warn(`[browser-bridge] abort send failed (viewId=${viewId}): ${(e as Error).message}`);
	}
}
