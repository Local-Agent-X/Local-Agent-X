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
