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
import {
	BridgeOpError, BridgeTimeoutError, BridgeUnavailableError, BridgeViewClosedError,
	CAPTURE_TIMEOUT_MS, CLEAR_PARTITION_TIMEOUT_MS, EXEC_TIMEOUT_MS, INPUT_TIMEOUT_MS,
	LIFECYCLE_TIMEOUT_MS, NAVIGATE_DESKTOP_TIMEOUT_MS, NAVIGATE_REPLY_GRACE_MS,
	RESULT_TYPES,
	type BridgeInputEvent, type BridgeReply, type BridgeRect, type BrowserInputResult,
	type BrowserLifecycleOp, type BrowserLifecycleResult, type BrowserNavigateResult,
	type InAppDialogSummary, type UserActiveResult,
} from "./bridge-client-contract.js";

export {
	BridgeOpError, BridgeTimeoutError, BridgeUnavailableError, BridgeViewClosedError,
	CAPTURE_TIMEOUT_MS, CLEAR_PARTITION_TIMEOUT_MS, EXEC_TIMEOUT_MS, INPUT_TIMEOUT_MS,
	LIFECYCLE_TIMEOUT_MS, NAVIGATE_DESKTOP_TIMEOUT_MS, NAVIGATE_REPLY_GRACE_MS,
} from "./bridge-client-contract.js";
export type {
	BridgeInputEvent, BridgeInputModifier, BridgeKeyEvent, BridgeMouseEvent,
	BridgeMouseWheelEvent, BridgePingResult, BridgeRect, BrowserInputResult,
	BrowserLifecycleOp, BrowserLifecycleResult, BrowserNavigateResult,
	BrowserViewInfo, InAppDialogSummary, UserActiveResult,
} from "./bridge-client-contract.js";

const logger = createLogger("browser-bridge");

export function isUserActiveResult(result: BrowserInputResult): result is UserActiveResult {
	return result?.userActive === true;
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
	opts?: { partition?: string; bounds?: BridgeRect; sessionId?: string },
): Promise<BrowserLifecycleResult> {
	if (op === "create" && !opts?.partition) {
		throw new BridgeOpError(`lifecycle:${op}`, viewId, "create requires a partition");
	}
	// sessionId rides the "show" op so the desktop anchors the surface to THIS
	// session (browser-surface-policy per-session anchor); ignored by other ops.
	const reply = await request(`lifecycle:${op}`, viewId, { type: "lax:browser-lifecycle", op, viewId, partition: opts?.partition, bounds: opts?.bounds, sessionId: opts?.sessionId }, LIFECYCLE_TIMEOUT_MS);
	return { view: reply.view, views: reply.views, ping: reply.ping };
}

export async function browserNavigate(viewId: string, url: string, sessionId?: string): Promise<BrowserNavigateResult> {
	// sessionId lets the desktop navigate-onSuccess SEED this session's anchor —
	// the first surface is usually a navigate, so a later new_tab/switch follows.
	const reply = await request("navigate", viewId, { type: "lax:browser-navigate", viewId, url, timeoutMs: NAVIGATE_DESKTOP_TIMEOUT_MS, sessionId }, NAVIGATE_DESKTOP_TIMEOUT_MS + NAVIGATE_REPLY_GRACE_MS);
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
