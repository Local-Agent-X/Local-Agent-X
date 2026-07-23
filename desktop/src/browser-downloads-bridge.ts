/**
 * Desktop half of the in-app download plumbing.
 *
 * Attributes quarantined downloads (browser-partition.ts registry) to the
 * pool view that triggered them, and PUSHES every terminal entry
 * (completed/cancelled/interrupted) to the server child as a
 * fire-and-forget "lax:browser-download-event" — same posture as the
 * UI-event sink. Push (not pull) because the server's tool-facing
 * getDownloads() is synchronous by contract: by the time the agent asks,
 * completed downloads must already be in the canonical records
 * (src/browser/downloads.ts ingests on arrival). The server owns ALL
 * policy — hashing, type detection, quarantine/release; nothing here
 * inspects bytes.
 *
 * Reliability is an outbox: an entry is marked reported ONLY after a
 * successful send, and every (re)wire — wireBrowserEgressEvaluator runs
 * once per server (re)spawn — flushes the unreported backlog, so a dead
 * child never silently loses an entry. The server-side ingest dedupes by
 * download id, so at-least-once delivery stays exactly-once recorded.
 */

import type { WebContents } from "electron";

import {
	listQuarantinedDownloads,
	setDownloadContextResolver,
	setDownloadDoneListener,
	type QuarantinedDownload,
} from "./browser-partition";
import { clearAdoptedViews, getBrowserView, listBrowserViews } from "./browser-views";

/** Returns true only when the message reached the child (proc.send truth). */
export type DownloadEventSink = (msg: Record<string, unknown>) => boolean;

let sink: DownloadEventSink | null = null;

const TERMINAL_STATES = new Set(["completed", "cancelled", "interrupted"]);

/** webContents → owning pool viewId; null for popups / non-pool contents. */
function resolveViewId(wc: WebContents | undefined): string | null {
	if (!wc) return null;
	for (const info of listBrowserViews()) {
		const view = getBrowserView(info.viewId);
		if (view && !view.webContents.isDestroyed() && view.webContents.id === wc.id) return info.viewId;
	}
	return null;
}

function toWireEvent(entry: QuarantinedDownload): Record<string, unknown> {
	return {
		type: "lax:browser-download-event",
		// Top-level viewId: the server parses the owning session out of it
		// (bridge-perception.sessionIdFromViewId), exactly like ui-events.
		viewId: entry.viewId,
		download: {
			id: entry.id,
			url: entry.url,
			pageUrl: entry.pageUrl,
			filename: entry.filename,
			mime: entry.mime,
			bytes: entry.bytes,
			state: entry.state,
			savePath: entry.savePath,
		},
	};
}

/** Push one terminal entry; mark reported ONLY on a successful send. */
function report(entry: QuarantinedDownload): void {
	if (!sink || entry.reported || !TERMINAL_STATES.has(entry.state)) return;
	try {
		if (sink(toWireEvent(entry))) entry.reported = true;
	} catch {
		/* child gone — stays unreported; the next wire flushes it */
	}
}

/** Re-send every terminal entry that never reached a live server child. */
export function flushUnreportedDownloads(): void {
	for (const entry of listQuarantinedDownloads()) report(entry);
}

/**
 * Arm attribution + the push channel. Called from wireBrowserEgressEvaluator
 * on every server (re)spawn so the closure always holds the live child.
 */
export function wireDownloadBridge(send: DownloadEventSink): void {
	sink = send;
	// The old child's adoptions died with it and no "release" will arrive —
	// clear the trust mirror; the new child replays live ones on subscribe.
	clearAdoptedViews();
	setDownloadContextResolver((wc) => ({
		viewId: resolveViewId(wc),
		pageUrl: wc && !wc.isDestroyed() ? wc.getURL() : "",
	}));
	setDownloadDoneListener(report);
	flushUnreportedDownloads();
}
