/** Canonical server→desktop browser bridge. Container callers use the
 * authenticated relay, whose parent re-enters the same request seam. */

import { createLogger } from "../logger.js";
import { answerEgressAsk } from "./bridge-egress.js";
import { browserContainerRelayActivated, relayBrowserAbort, relayBrowserRequest, type BrowserRelayRequest } from "./container-bridge-relay.js";
import { startEgressWorkerHost } from "./egress-worker-host.js";
import {
	handleAgentViewClosed,
	handleBrowserDownloadEvent,
	handleBrowserUiEvent,
	type BridgeConsoleEntry,
	type BridgeNetworkEntry,
} from "./bridge-perception.js";

const logger = createLogger("browser-bridge");

// ── Per-op timeouts ─────────
// navigate: the desktop enforces its own load deadline (sent in the message);
// the client waits that plus a reply grace — 28s ceiling, under the tool wedge.
export const LIFECYCLE_TIMEOUT_MS = 8_000;
export const NAVIGATE_DESKTOP_TIMEOUT_MS = 25_000;
export const NAVIGATE_REPLY_GRACE_MS = 3_000; // 25s + 3s = 28s total
export const EXEC_TIMEOUT_MS = 10_000;
export const INPUT_TIMEOUT_MS = 5_000;
export const CAPTURE_TIMEOUT_MS = 10_000;
// clear-partition blanks every open view on the partition THEN clears storage
// (loads + a storage flush) — longer ceiling than a bare lifecycle op.
export const CLEAR_PARTITION_TIMEOUT_MS = 12_000;

// ── Wire types (mirrored in desktop/src/server-bridge-browser.ts) ─────────
export interface BridgeRect { x: number; y: number; width: number; height: number }

export interface BrowserViewInfo {
	viewId: string;
	partition: string;
	url: string;
	title: string;
	attached: boolean;
	/** Set at creation: agent-driving bridge view vs. the renderer's own. */
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
	// userActive: the co-drive lock says the human is driving — read by the
	// in-app backend's pre-exec arbitration (eval bypasses the input gate).
	ping?: { ok: boolean; url?: string; title?: string; userActive?: boolean };
}
/** status: main-frame HTTP response code, when the desktop observed one
 *  (did-navigate). Absent for non-HTTP loads → callers print "unknown". */
export interface BrowserNavigateResult { url: string; title: string; status?: number }

/** The desktop refused an agent input: the HUMAN is driving the view
 *  (co-drive lock). A STATUS ("user took the wheel"), not an error. */
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
	status?: number;
	entries?: BridgeConsoleEntry[];
	network?: { entries: BridgeNetworkEntry[]; inFlight: number };
	dialogs?: InAppDialogSummary[];
	handled?: InAppDialogSummary | null;
}

const RESULT_TYPES = new Set([
	"lax:browser-lifecycle-result",
	"lax:browser-navigate-result",
	"lax:browser-exec-result",
	"lax:browser-input-result",
	"lax:browser-capture-result",
	"lax:browser-clear-partition-result",
	"lax:browser-read-console-result",
	"lax:browser-read-network-result",
	"lax:browser-dialogs-result",
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
	return browserContainerRelayActivated() || desktopBrowserBridgeAvailable();
}

const desktopBrowserBridgeAvailable = (): boolean => process.env.LAX_DESKTOP_BRIDGE === "1" && typeof process.send === "function";

function ensureListener(): void {
	if (listenerAttached) return;
	listenerAttached = true;
	process.on("message", (msg: BridgeReply & { url?: string; method?: string; pageUrl?: string; body?: string; viewId?: string }) => {
		if (!msg || typeof msg.type !== "string") return;
		if (msg.type === "lax:browser-egress-ask") {
			if (typeof msg.id !== "number" || typeof msg.url !== "string") return;
			answerEgressAsk({
				id: msg.id,
				url: msg.url,
				method: typeof msg.method === "string" ? msg.method : undefined,
				pageUrl: typeof msg.pageUrl === "string" ? msg.pageUrl : undefined,
				body: typeof msg.body === "string" ? msg.body : undefined,
				viewId: typeof msg.viewId === "string" ? msg.viewId : undefined,
			});
			return;
		}
		if (msg.type === "lax:browser-ui-event") {
			// Desktop-initiated, fire-and-forget (no id) → ui:browser bus (bridge-perception.ts).
			handleBrowserUiEvent(msg as unknown as Record<string, unknown>);
			return;
		}
		if (msg.type === "lax:browser-download-event") {
			// Desktop-initiated, fire-and-forget → canonical download ingest.
			handleBrowserDownloadEvent(msg as unknown as Record<string, unknown>);
			return;
		}
		if (msg.type === "lax:browser-agent-view-closed") {
			// User closed an agent view from the tab strip. Reject its pending
			// ops NOW (they'd otherwise run to their timeout against a dead
			// view), then let the owning backend mark the tab for recreation.
			if (typeof msg.viewId === "string" && msg.viewId !== "") {
				rejectPendingForView(msg.viewId, -1);
				handleAgentViewClosed(msg as unknown as Record<string, unknown>);
			}
			return;
		}
		if (!RESULT_TYPES.has(msg.type)) return;
		const entry = pendingOps.get(msg.id);
		if (entry) entry.settle(msg);
	});
}

/** Arm the reverse egress-ask channel (and reply correlation) without
 *  issuing an op. Wire this once at server boot when running under the
 *  desktop; harmless no-op elsewhere. Also boots the off-loop egress worker
 *  (egress-worker-host.ts) and announces its pipe endpoint to the desktop —
 *  the in-loop ask branch above STAYS armed as the fallback path (the desktop
 *  uses it until it connects, and whenever the worker is down). */
export function initBrowserBridgeClient(): void {
	if (!desktopBrowserBridgeAvailable()) return;
	ensureListener();
	startEgressWorkerHost((pipeName) => {
		// Re-announced on every worker (re)boot — each spawn mints a new name.
		try {
			process.send!({ type: "lax:browser-egress-endpoint", pipeName });
		} catch (e) {
			logger.warn(`[browser-bridge] egress-endpoint announce failed: ${(e as Error).message}`);
		}
	});
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
	if (browserContainerRelayActivated()) {
		return relayBrowserRequest({ op, viewId, message, timeoutMs }) as Promise<BridgeReply>;
	}
	return requestDesktopBrowserBridge({ op, viewId, message, timeoutMs });
}

export function requestDesktopBrowserBridge(request: BrowserRelayRequest): Promise<BridgeReply> {
	const { op, viewId, message, timeoutMs } = request;
	if (!desktopBrowserBridgeAvailable()) return Promise.reject(new BridgeUnavailableError(op));
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
			process.send!({ ...message, id });
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
	const reply = await request(`lifecycle:${op}`, viewId, { type: "lax:browser-lifecycle", op, viewId, partition: opts?.partition, bounds: opts?.bounds }, LIFECYCLE_TIMEOUT_MS);
	return { view: reply.view, views: reply.views, ping: reply.ping };
}

export async function browserNavigate(viewId: string, url: string): Promise<BrowserNavigateResult> {
	const reply = await request("navigate", viewId, { type: "lax:browser-navigate", viewId, url, timeoutMs: NAVIGATE_DESKTOP_TIMEOUT_MS }, NAVIGATE_DESKTOP_TIMEOUT_MS + NAVIGATE_REPLY_GRACE_MS);
	return { url: reply.url ?? "", title: reply.title ?? "", ...(typeof reply.status === "number" ? { status: reply.status } : {}) };
}

/** Read the view's bounded console ring (desktop browser-perception.ts). */
export async function browserReadConsole(viewId: string): Promise<BridgeConsoleEntry[]> {
	const reply = await request("read-console", viewId, { type: "lax:browser-read-console", viewId }, LIFECYCLE_TIMEOUT_MS);
	return Array.isArray(reply.entries) ? reply.entries : [];
}

/** Read the view's partition-scoped network ring + in-flight counter. */
export async function browserReadNetwork(viewId: string): Promise<{ entries: BridgeNetworkEntry[]; inFlight: number }> {
	const reply = await request("read-network", viewId, { type: "lax:browser-read-network", viewId }, LIFECYCLE_TIMEOUT_MS);
	const net = reply.network;
	return { entries: Array.isArray(net?.entries) ? net.entries : [], inFlight: typeof net?.inFlight === "number" ? net.inFlight : 0 };
}

/** Desktop beforeunload-dialog queue entry (desktop/src/browser-dialogs.ts). */
export interface InAppDialogSummary { type: string; message: string }

/** Dialog queue ops: list pending, or accept/dismiss the next queued entry
 *  (handled: null when nothing was pending). */
export async function browserDialogs(
	viewId: string,
	op: "list" | "accept" | "dismiss",
): Promise<{ dialogs: InAppDialogSummary[]; handled: InAppDialogSummary | null }> {
	const reply = await request(`dialogs:${op}`, viewId, { type: "lax:browser-dialogs", viewId, op }, LIFECYCLE_TIMEOUT_MS);
	return {
		dialogs: Array.isArray(reply.dialogs) ? reply.dialogs : [],
		handled: reply.handled ?? null,
	};
}

/** Runs `script` in the view's ISOLATED world (the only supported world —
 *  main-world execution is deliberately not offered by the desktop side).
 *  `allFrames: true` aggregates per same-origin frame (main frame first);
 *  frames unreachable in an isolated world are skipped fail-closed. */
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
	const reply = await request("input", viewId, { type: "lax:browser-input", viewId, event }, INPUT_TIMEOUT_MS);
	return reply.userActive === true ? { userActive: true } : undefined;
}

/** Returns the view's current paint as a base64 PNG. */
export async function browserCapture(viewId: string): Promise<string> {
	const reply = await request("capture", viewId, { type: "lax:browser-capture", viewId }, CAPTURE_TIMEOUT_MS);
	if (typeof reply.pngB64 !== "string" || reply.pngB64.length === 0) {
		throw new BridgeOpError("capture", viewId, "desktop returned no image data");
	}
	return reply.pngB64;
}

/**
 * Wipe a profile partition's saved logins (cookies + all storage) on the
 * Electron backend. The desktop enforces the fail-safe ordering INSIDE one
 * handler — every open view on the partition navigates to about:blank FIRST,
 * then session.clearStorageData() runs — so no in-memory cookie of a live
 * page survives (a cross-process navigate/clear would race). Fails closed
 * off-desktop: the caller treats BridgeUnavailableError as "no Electron
 * store to clear" and still wipes the CDP userDataDir twin. The `partition`
 * doubles as the correlation label for typed errors.
 */
export async function browserClearPartition(partition: string): Promise<void> {
	await request("clear-partition", partition, { type: "lax:browser-clear-partition", partition }, CLEAR_PARTITION_TIMEOUT_MS);
}

/** Fire-and-forget: stop the view's in-flight load. No id, no reply. */
export function browserAbort(viewId: string): void {
	if (browserContainerRelayActivated()) {
		void relayBrowserAbort(viewId).catch(error => logger.warn(`[browser-bridge] relay abort failed (viewId=${viewId}): ${(error as Error).message}`));
		return;
	}
	browserAbortDesktop(viewId);
}

export function browserAbortDesktop(viewId: string): void {
	if (!desktopBrowserBridgeAvailable()) return;
	try {
		process.send!({ type: "lax:browser-abort", viewId });
	} catch (e) {
		logger.warn(`[browser-bridge] abort send failed (viewId=${viewId}): ${(e as Error).message}`);
	}
}
