/**
 * Browser perception plumbing on the SERVER side of the bridge:
 *
 *   - entry types for the desktop's console/network rings
 *     (desktop/src/browser-perception.ts is the producer),
 *   - compact human-readable reports the in-app backend returns from
 *     readConsole()/readNetwork() (newest last, bounded upstream),
 *   - the inbound "lax:browser-ui-event" handler bridge-client's listener
 *     delegates to: it re-shapes the desktop's fire-and-forget message into
 *     a `ui:browser` bus event. The ui-event-store is the LAW for schema/
 *     redaction — this producer only supplies plain-label actions and parses
 *     the owning session out of the viewId.
 *
 * Session scoping: agent views are named `view-<sessionId>-<profileId>[-tN]`.
 * Session and profile ids may themselves contain hyphens, so the parse strips
 * the `view-` prefix and any `-tN` tab suffix, then drops the LAST hyphen
 * segment as the profileId (accepted simplification — a profileId containing
 * a hyphen would leave its head glued to the sessionId). User views
 * (foreground / user-N / profile-*) carry no session → global scope.
 */

import { EventBus } from "../event-bus.js";
import { createLogger } from "../logger.js";
import { ingestInAppDownload } from "./downloads.js";

const logger = createLogger("browser.bridge-perception");

export interface BridgeConsoleEntry {
	level: string;
	message: string;
	ts: number;
}

export interface BridgeNetworkEntry {
	url: string;
	method: string;
	status?: number;
	error?: string;
	ts: number;
}

/** Parse the owning sessionId from an AGENT viewId; undefined for user views. */
export function sessionIdFromViewId(viewId: unknown): string | undefined {
	if (typeof viewId !== "string" || !viewId.startsWith("view-")) return undefined;
	const rest = viewId.slice("view-".length).replace(/-t\d+$/, "");
	const cut = rest.lastIndexOf("-");
	if (cut <= 0) return undefined; // no profile segment → not the agent shape
	return rest.slice(0, cut);
}

/**
 * Authorization-grade ownership: does `viewId` name a view OWNED by `sessionId`?
 *
 * Unlike sessionIdFromViewId (a best-effort attribution parser that drops the
 * LAST hyphen segment and so mis-splits any profileId containing a hyphen, e.g.
 * the `prof-<b36>-<hex>` custom-profile shape), this RECONSTRUCTS the mint
 * instead of parsing the ambiguous session/profile boundary. inAppViewId names
 * every agent view `view-<sessionId>-<profileId>` with an optional `-tN` tab
 * suffix, so a view is owned iff its id begins with the exact
 * `view-<sessionId>-` prefix AND carries at least one character after it (a
 * non-empty profile/tab segment). The trailing hyphen in the prefix keeps
 * sibling ids apart — `view-s1-…` never matches a session named `s12`.
 *
 * Known boundary: because the profileId itself may contain hyphens, this cannot
 * distinguish session `s` (profile `a-b`) from a DESCENDANT session `s-a`
 * (profile `b`) — the spawned-branch id shape `<parent>-b<i>` (dream-check.ts).
 * It therefore confines a caller to its own session PLUS that session's own
 * hyphen-nested descendants, and rejects every unrelated session (agent/uuid
 * ids never prefix-nest). Closing the descendant residual needs the profileId
 * threaded to the caller for an exact match, which the container projection
 * does not carry today.
 */
export function viewBelongsToSession(viewId: unknown, sessionId: string): boolean {
	if (typeof viewId !== "string" || !sessionId) return false;
	const prefix = `view-${sessionId}-`;
	return viewId.startsWith(prefix) && viewId.length > prefix.length;
}

/**
 * Session-level counterpart to viewBelongsToSession: does `sessionId` name the
 * relay's OWNING session, or one of its hyphen-nested descendants? Used to
 * confine a container's forwarded data-lineage state (taint/canaries) to the
 * session that owns the relay — the same boundary viewBelongsToSession applies
 * to relayed browser ops, at the session-id granularity the lineage payload
 * carries. The trailing hyphen keeps siblings apart (`s1` never owns `s12`); a
 * spawned-branch id (`<owner>-b<i>`) IS admitted, matching viewBelongsToSession's
 * documented descendant reach.
 */
export function sessionBelongsToSession(sessionId: unknown, ownerSessionId: string): boolean {
	if (typeof sessionId !== "string" || !sessionId || !ownerSessionId) return false;
	return sessionId === ownerSessionId || sessionId.startsWith(`${ownerSessionId}-`);
}

// ── Adopted-view session registry ─────────
// A user view taken over via switch_tab keeps its USER viewId (foreground /
// user-N), which sessionIdFromViewId can't attribute — downloads the agent
// triggers on an adopted tab would otherwise vanish from its getDownloads()
// forever. The backend registers adoptions here (and clears them at close),
// so download attribution follows the takeover.
const adoptedViewSessions = new Map<string, string>();

// Mirror seam: the egress worker thread (egress-worker.ts) keeps a shadow copy
// of this registry — worker_threads get their own module instance, so it can't
// read the map above. null sessionId = adoption dropped.
type AdoptedViewListener = (viewId: string, sessionId: string | null) => void;
const adoptedViewListeners = new Set<AdoptedViewListener>();

/** Subscribe to adopted-view changes. Replays every current adoption
 *  synchronously on subscribe (restarted mirrors start complete), then fires
 *  on every register/unregister. Returns an unsubscribe. */
export function subscribeAdoptedViewChanges(cb: AdoptedViewListener): () => void {
	adoptedViewListeners.add(cb);
	for (const [viewId, sessionId] of adoptedViewSessions) cb(viewId, sessionId);
	return () => { adoptedViewListeners.delete(cb); };
}

function notifyAdoptedView(viewId: string, sessionId: string | null): void {
	for (const cb of adoptedViewListeners) cb(viewId, sessionId);
}

export function registerAdoptedView(viewId: string, sessionId: string): void {
	adoptedViewSessions.set(viewId, sessionId);
	notifyAdoptedView(viewId, sessionId);
}

/** The session that adopted this (user-origin) viewId, if any. Lets the egress
 *  gate attribute a taken-over tab's page requests to the driving session. */
export function adoptedViewSession(viewId: string): string | undefined {
	return adoptedViewSessions.get(viewId);
}

/** Drop every adoption a session holds (backend close). */
export function unregisterAdoptedViews(sessionId: string): void {
	for (const [viewId, sess] of adoptedViewSessions) {
		if (sess === sessionId) {
			adoptedViewSessions.delete(viewId);
			notifyAdoptedView(viewId, null);
		}
	}
}

export function _resetAdoptedViewsForTest(): void {
	for (const viewId of adoptedViewSessions.keys()) notifyAdoptedView(viewId, null);
	adoptedViewSessions.clear();
}

// ── External agent-view close (user ✕ on an agent pill) ─────────
// The desktop pushes "lax:browser-agent-view-closed" when the USER closes an
// agent-owned view from the tab strip. The owning backend must mark that tab
// gone so its next op recreates the view instead of driving a dead viewId.
// Registered by instance.ts (which owns the session→backend map); a seam
// rather than an import because instance.ts sits above this module.
let agentViewClosedHandler: ((viewId: string) => void) | null = null;

export function setAgentViewClosedHandler(fn: ((viewId: string) => void) | null): void {
	agentViewClosedHandler = fn;
}

export function handleAgentViewClosed(msg: Record<string, unknown>): void {
	if (typeof msg.viewId !== "string" || msg.viewId === "") return;
	agentViewClosedHandler?.(msg.viewId);
}

/**
 * Inbound desktop UI-activity message → `ui:browser` bus event. Fire-and-
 * forget on both hops: no reply, and bus emission failures stay in the bus.
 * The surface is stamped HERE (never trusted from the wire) and action must
 * be a plain string — the store's label law rejects smuggled values.
 */
export function handleBrowserUiEvent(msg: Record<string, unknown>): void {
	if (typeof msg.action !== "string" || msg.action.trim() === "") return;
	const event: Record<string, unknown> = {
		surface: "browser",
		action: msg.action,
		ts: typeof msg.ts === "number" && Number.isFinite(msg.ts) ? msg.ts : Date.now(),
	};
	if (typeof msg.target === "string" && msg.target !== "") event.target = msg.target;
	const sessionId = sessionIdFromViewId(msg.viewId);
	if (sessionId !== undefined) event.sessionId = sessionId;
	void EventBus.emit("ui:browser", event);
}

/**
 * Inbound desktop download push ("lax:browser-download-event", fire-and-
 * forget like ui-events) → canonical download records (downloads.ts). Only
 * AGENT-attributed downloads enter session records: the owning session is
 * parsed from the top-level viewId, or resolved through the adopted-view
 * registry for taken-over user tabs; un-adopted user views and unattributed
 * (null) viewIds are skipped — their bytes stay in the desktop quarantine.
 * The ingest is async (stream-hash) and self-deduping; kicking it off
 * fire-and-forget here matches the CDP path's page.on("download") posture.
 */
export function handleBrowserDownloadEvent(msg: Record<string, unknown>): void {
	const sessionId = sessionIdFromViewId(msg.viewId)
		?? (typeof msg.viewId === "string" ? adoptedViewSessions.get(msg.viewId) : undefined);
	if (sessionId === undefined) return;
	const d = msg.download as Record<string, unknown> | null | undefined;
	if (!d || typeof d.id !== "string" || typeof d.savePath !== "string" || typeof d.state !== "string") return;
	void ingestInAppDownload(sessionId, {
		id: d.id,
		state: d.state,
		savePath: d.savePath,
		url: typeof d.url === "string" ? d.url : "",
		pageUrl: typeof d.pageUrl === "string" ? d.pageUrl : "",
		filename: typeof d.filename === "string" ? d.filename : "download.bin",
		mime: typeof d.mime === "string" ? d.mime : "",
		bytes: typeof d.bytes === "number" ? d.bytes : 0,
	}).catch((e) => {
		// ingestInAppDownload records failures itself; this only catches a bug
		// in the ingest machinery — never let it become an unhandled rejection.
		logger.warn(`[browser-downloads] ingest crashed for ${d.id}: ${(e as Error).message}`);
	});
}

/** Compact console report: counts + levels up front, entries newest last. */
export function formatConsoleReport(entries: BridgeConsoleEntry[]): string {
	if (entries.length === 0) return "No console messages captured for this tab.";
	const errors = entries.filter((e) => e.level === "error").length;
	const warnings = entries.filter((e) => e.level === "warning" || e.level === "warn").length;
	const lines = entries.map((e) => `[${e.level}] ${e.message}`);
	return `Console: ${entries.length} message(s) (${errors} error(s), ${warnings} warning(s)), newest last:\n${lines.join("\n")}`;
}

/** Compact network report: one line per request (status or error), newest
 *  last, plus the live in-flight count. */
export function formatNetworkReport(entries: BridgeNetworkEntry[], inFlight: number): string {
	const tail = `${inFlight} request(s) in flight`;
	if (entries.length === 0) return `No network requests captured for this tab. ${tail}`;
	const failures = entries.filter((e) => e.error !== undefined || (e.status ?? 0) >= 400).length;
	const lines = entries.map((e) =>
		e.error !== undefined
			? `${e.method} FAILED (${e.error}) ${e.url}`
			: `${e.method} ${e.status ?? "?"} ${e.url}`,
	);
	return `Network: ${entries.length} request(s) captured (${failures} failed/error status), newest last:\n${lines.join("\n")}\n${tail}`;
}
