/**
 * Local Agent X — browser agent-perception buffers + UI-event production.
 *
 * Two concerns, both bounded rings, both fed by seams the pool/partition
 * modules call (this module imports NOTHING at runtime — a pure leaf, so
 * it stays unit-testable without Electron):
 *
 *   1. Per-VIEW console ring: 'console-message' plus synthetic error
 *      entries for 'render-process-gone'/'unresponsive'. Wired by
 *      browser-views.ts via the ViewLifecycleObserver seam; cleared on
 *      view close so rings never outlive their view.
 *   2. Per-PARTITION network ring + in-flight counter: fed from the ONE
 *      webRequest stack browser-partition.ts installs per session.
 *      Network capture is session-scoped in Electron, so entries are
 *      stored per partition and the read op resolves viewId → partition;
 *      attributing individual requests to views would need a
 *      webContentsId→viewId map that misses session-context requests —
 *      per-partition is the simpler CORRECT attribution.
 *
 * UI events: for USER views only (agentDriven:false — agent-driven views
 * describe the agent's own activity, worthless in the user-activity
 * digest), navigation/title/open/close are forwarded to the server child
 * as fire-and-forget "lax:browser-ui-event" messages through the sink
 * wireBrowserEgressEvaluator installs. Console/network entries are NEVER
 * emitted as UI events — the read_console/read_network ops are their
 * only surface (deliberate noise-control narrowing).
 */

import type { WebContents } from "electron";

export interface ConsoleEntry {
	level: string;
	message: string;
	ts: number;
}

export interface NetworkEntry {
	url: string;
	method: string;
	status?: number;
	error?: string;
	ts: number;
}

export const RING_MAX_ENTRIES = 100;
export const CONSOLE_MESSAGE_MAX_CHARS = 300;
export const UI_TITLE_MAX_CHARS = 120;
const URL_MAX_CHARS = 200;
const MAX_PARTITION_RINGS = 32;

/** Push onto a bounded ring: oldest entries fall off the front. */
export function pushBounded<T>(ring: T[], entry: T, max = RING_MAX_ENTRIES): void {
	ring.push(entry);
	if (ring.length > max) ring.splice(0, ring.length - max);
}

export function trimText(text: unknown, max: number): string {
	const s = typeof text === "string" ? text : String(text ?? "");
	return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

// Legacy console-message levels (Electron passes 0..3 in the positional
// signature; newer Electron also puts a string level on the event object).
const LEGACY_LEVELS = ["debug", "info", "warning", "error"] as const;

/**
 * Store-time URL redaction for the network ring: query/fragment (where
 * values live) and userinfo (where credentials live) never enter the ring,
 * so read_network can't replay them later. Mirrors the server's
 * ui-event-store law — duplicated MINIMALLY here because desktop main
 * cannot import server modules across the project boundary.
 */
export function scrubRingUrl(url: unknown): string {
	const s = typeof url === "string" ? url : String(url ?? "");
	return trimText(s.replace(/[?#].*$/, "").replace(/^([a-z][\w+.-]*:\/\/|\/\/)?[^/]*@/i, "$1"), URL_MAX_CHARS);
}

// ── UI-event sink (desktop → server, fire-and-forget) ─────────
type UiEventSink = (msg: Record<string, unknown>) => void;
let uiEventSink: UiEventSink | null = null;

/** Point UI events at the live server child. Re-wired on every (re)spawn
 *  by wireBrowserEgressEvaluator; a dead child just drops events. */
export function setBrowserUiEventSink(sink: UiEventSink | null): void {
	uiEventSink = sink;
}

function emitUiEvent(action: string, viewId: string, target?: string): void {
	if (!uiEventSink) return;
	const msg: Record<string, unknown> = {
		type: "lax:browser-ui-event",
		surface: "browser",
		action,
		viewId,
		ts: Date.now(),
	};
	if (target !== undefined && target !== "") msg.target = target;
	try {
		uiEventSink(msg);
	} catch {
		/* child gone — drop, never break the view's event handlers */
	}
}

// ── Per-view console rings ─────────
interface ViewPerception {
	entries: ConsoleEntry[];
	agentDriven: boolean;
	cleanup: () => void;
}

const viewsById = new Map<string, ViewPerception>();

// Views whose NEXT did-navigate was initiated by the agent over the bridge
// (server-bridge navigate marks this right before loadURL). Their navigate —
// and its follow-up title update — must not be emitted as user activity.
const agentNavPending = new Set<string>();
const titleSuppressed = new Set<string>();

/** Flag the view's next did-navigate as agent-initiated (bridge navigate). */
export function markAgentNavigation(viewId: string): void {
	agentNavPending.add(viewId);
}

function pushConsole(viewId: string, level: string, message: string): void {
	const view = viewsById.get(viewId);
	if (!view) return;
	pushBounded(view.entries, { level, message: trimText(message, CONSOLE_MESSAGE_MAX_CHARS), ts: Date.now() });
}

/** Wire a view's perception at creation (ViewLifecycleObserver.onViewCreated). */
export function attachViewPerception(viewId: string, wc: WebContents, agentDriven: boolean): void {
	if (viewsById.has(viewId)) detachViewPerception(viewId);
	// Both console-message shapes: new event-object level/message win when
	// present; the legacy positional args are the fallback.
	const onConsole = (event: unknown, legacyLevel?: number, legacyMessage?: string): void => {
		const ev = event as { level?: unknown; message?: unknown } | undefined;
		const level = typeof ev?.level === "string"
			? ev.level
			: LEGACY_LEVELS[typeof legacyLevel === "number" ? legacyLevel : 1] ?? "info";
		const message = typeof ev?.message === "string" ? ev.message : legacyMessage ?? "";
		pushConsole(viewId, level, message);
	};
	const onGone = (_e: unknown, details: unknown): void => {
		const reason = (details as { reason?: unknown } | undefined)?.reason;
		pushConsole(viewId, "error", `renderer process gone (${typeof reason === "string" ? reason : "unknown"})`);
	};
	const onUnresponsive = (): void => pushConsole(viewId, "error", "page became unresponsive");
	const onNavigate = (_e: unknown, url: unknown): void => {
		// A bridge-driven navigation on an ADOPTED user view is the AGENT's
		// action — narrating it back as user activity would feed the agent
		// its own moves (and poison the co-drive digest). markAgentNavigation
		// flags it just before loadURL; consume the flag here.
		if (agentNavPending.delete(viewId)) {
			titleSuppressed.add(viewId);
			return;
		}
		titleSuppressed.delete(viewId);
		if (!agentDriven) emitUiEvent("navigate", viewId, trimText(url, URL_MAX_CHARS));
	};
	const onTitle = (_e: unknown, title: unknown): void => {
		if (titleSuppressed.has(viewId)) return; // title of an agent navigation
		if (!agentDriven) emitUiEvent("title", viewId, trimText(title, UI_TITLE_MAX_CHARS));
	};
	wc.on("console-message", onConsole as never);
	wc.on("render-process-gone", onGone as never);
	wc.on("unresponsive", onUnresponsive);
	wc.on("did-navigate", onNavigate as never);
	wc.on("page-title-updated", onTitle as never);
	viewsById.set(viewId, {
		entries: [],
		agentDriven,
		cleanup: () => {
			if (wc.isDestroyed()) return;
			wc.off("console-message", onConsole as never);
			wc.off("render-process-gone", onGone as never);
			wc.off("unresponsive", onUnresponsive);
			wc.off("did-navigate", onNavigate as never);
			wc.off("page-title-updated", onTitle as never);
		},
	});
	if (!agentDriven) emitUiEvent("tab-open", viewId);
}

/** Tear down a view's perception at close (ViewLifecycleObserver.onViewClosed).
 *  Rings must not leak: entries are dropped with the view. */
export function detachViewPerception(viewId: string): void {
	const view = viewsById.get(viewId);
	if (!view) return;
	viewsById.delete(viewId);
	try {
		view.cleanup();
	} catch {
		/* webContents already torn down */
	}
	if (!view.agentDriven) emitUiEvent("tab-close", viewId);
}

/** Snapshot the view's console ring, oldest first. Unknown view → empty. */
export function readConsoleEntries(viewId: string): ConsoleEntry[] {
	return [...(viewsById.get(viewId)?.entries ?? [])];
}

// ── Per-partition network rings ─────────
// In-flight is a SET of unsettled Electron request ids, not a counter: a
// redirect re-enters onBeforeRequest with the SAME id (per-hop egress
// evaluation depends on that), while onCompleted fires once for the whole
// chain — a raw counter therefore drifts +1 per hop forever. Set.add is
// idempotent across hops; settle deletes the id whichever way it ends.
interface PartitionNetwork {
	entries: NetworkEntry[];
	unsettled: Set<number>;
}

const netByPartition = new Map<string, PartitionNetwork>();

function partitionNet(partition: string): PartitionNetwork {
	let net = netByPartition.get(partition);
	if (!net) {
		net = { entries: [], unsettled: new Set() };
		netByPartition.set(partition, net);
		// Bounded regardless of profile churn: evict the oldest partition ring.
		while (netByPartition.size > MAX_PARTITION_RINGS) {
			const oldest = netByPartition.keys().next().value;
			if (oldest === undefined) break;
			netByPartition.delete(oldest);
		}
	}
	return net;
}

export function noteRequestStart(partition: string, requestId: number): void {
	partitionNet(partition).unsettled.add(requestId);
}

export function noteRequestDone(
	partition: string,
	outcome: { id: number; url: string; method: string; statusCode: number },
): void {
	const net = partitionNet(partition);
	net.unsettled.delete(outcome.id);
	pushBounded(net.entries, {
		url: scrubRingUrl(outcome.url),
		method: outcome.method,
		status: outcome.statusCode,
		ts: Date.now(),
	});
}

export function noteRequestFailed(
	partition: string,
	outcome: { id: number; url: string; method: string; error: string },
): void {
	const net = partitionNet(partition);
	net.unsettled.delete(outcome.id);
	pushBounded(net.entries, {
		url: scrubRingUrl(outcome.url),
		method: outcome.method,
		error: outcome.error,
		ts: Date.now(),
	});
}

/** Snapshot the partition's network ring + in-flight counter. */
export function readNetworkEntries(partition: string): { entries: NetworkEntry[]; inFlight: number } {
	const net = netByPartition.get(partition);
	return { entries: [...(net?.entries ?? [])], inFlight: net?.unsettled.size ?? 0 };
}

export function _resetBrowserPerceptionForTest(): void {
	for (const view of viewsById.values()) {
		try { view.cleanup(); } catch { /* test teardown */ }
	}
	viewsById.clear();
	netByPartition.clear();
	agentNavPending.clear();
	titleSuppressed.clear();
	uiEventSink = null;
}
