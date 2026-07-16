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
 * parsed from the top-level viewId; user views and unattributed (null)
 * viewIds are skipped — their bytes stay in the desktop quarantine dir.
 * The ingest is async (stream-hash) and self-deduping; kicking it off
 * fire-and-forget here matches the CDP path's page.on("download") posture.
 */
export function handleBrowserDownloadEvent(msg: Record<string, unknown>): void {
	const sessionId = sessionIdFromViewId(msg.viewId);
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
