/**
 * Routing for in-app browser downloads: whose download is this?
 *
 * Agent-driven views keep the quarantine flow (nothing lands outside
 * quarantine, nothing auto-opens; the server owns release/approval). But the
 * user's OWN tabs are their browser — clicking a "download recovery codes"
 * link must land the file in ~/Downloads the way Chrome would, not vanish
 * into a quarantine only the agent can release. Same trust split, same
 * resolver, same fail-safe as the loopback carve-out
 * (browser-loopback-policy): only a webContents the trust resolver
 * POSITIVELY attributes to a user view routes to Downloads; agent views,
 * popups, and unresolvable webContents all stay quarantined.
 *
 * Pure module (no electron imports) so the routing is unit-testable.
 */
import { basename, extname, join } from "node:path";

import type { ViewTrust } from "./browser-loopback-policy";

/** One quarantined (agent-routed) download, registered at will-download time
 *  by browser-partition.ts and pushed to the server by the downloads bridge. */
export interface QuarantinedDownload {
	id: string;
	/** Pool view that triggered the download; null when the webContents is not
	 *  a pool view (popup / unresolvable). Resolved at will-download time. */
	viewId: string | null;
	/** Page URL of the triggering webContents at will-download time. */
	pageUrl: string;
	url: string;
	filename: string;
	mime: string;
	bytes: number;
	state: "progressing" | "completed" | "cancelled" | "interrupted";
	savePath: string;
	/** Set by browser-downloads-bridge once the entry reached a live server
	 *  child (outbox flag — mark ONLY after a successful send). */
	reported: boolean;
}

export function isUserDownload(
	webContentsId: number | undefined,
	resolveTrust: ((webContentsId: number) => ViewTrust | null) | null,
): boolean {
	if (webContentsId === undefined || !resolveTrust) return false;
	return resolveTrust(webContentsId) === "user";
}

/**
 * The one trust verdict for a pool view, shared by the download router and
 * the loopback carve-out. ADOPTION is load-bearing: a user view taken over
 * via switch_tab keeps agentDriven:false, but while adopted the AGENT is the
 * driver — the server's egress gate already attributes its requests to the
 * driving session, and its downloads must stay in quarantine where the
 * adopted-view attribution pipeline (bridge-perception adoptedViewSessions)
 * records them. agentDriven undefined = not a pool view (popup/unknown) →
 * null → strict everywhere.
 */
export function viewTrust(agentDriven: boolean | undefined, adopted: boolean): ViewTrust | null {
	if (agentDriven === undefined) return null;
	return agentDriven || adopted ? "agent" : "user";
}

// Windows device names break as filenames on a cross-platform app; stem
// match is enough ("CON.txt" is as broken as "CON").
const RESERVED_STEMS = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;
const MAX_BASENAME = 180; // headroom under common 255-byte filesystem limits

/** Collision-free save path: "report.pdf" → "report (1).pdf" → "report (2)
 *  .pdf"… until the name is free. The filename is reduced to a basename so a
 *  hostile Content-Disposition can never traverse out of the directory,
 *  clamped so an oversized name can't fail the write, and de-reserved for
 *  Windows device names. */
export function uniqueDownloadPath(
	dir: string,
	filename: string,
	exists: (path: string) => boolean,
): string {
	const safe = basename(filename || "").trim() || "download";
	const ext = extname(safe).slice(0, 32);
	let stem = safe.slice(0, safe.length - extname(safe).length) || "download";
	if (RESERVED_STEMS.test(stem)) stem = `_${stem}`;
	stem = stem.slice(0, MAX_BASENAME - ext.length);
	let candidate = join(dir, `${stem}${ext}`);
	for (let n = 1; exists(candidate); n++) candidate = join(dir, `${stem} (${n})${ext}`);
	return candidate;
}
