/**
 * Registry of USER-routed in-app browser downloads (the ones
 * browser-partition's will-download saves to ~/Downloads), so the pane's
 * Downloads panel can show them Chrome-style. Agent downloads live in the
 * quarantine registry (browser-partition.ts) — this one is strictly the
 * user's own files, which is also the open/reveal safety boundary: the IPC
 * layer only ever opens paths that came from THIS registry, never a
 * quarantine .part.
 *
 * In-memory, session-lifetime, newest-first, capped — matches Chrome's shelf
 * semantics (the files themselves persist in ~/Downloads regardless).
 * Pure module (no electron imports) so the bookkeeping is unit-testable.
 */

export interface UserDownload {
	id: string;
	filename: string;
	savePath: string;
	url: string;
	bytes: number;
	totalBytes: number;
	state: "progressing" | "completed" | "cancelled" | "interrupted";
	startedAt: number;
	doneAt?: number;
}

const MAX_ENTRIES = 200;
const entries = new Map<string, UserDownload>();

export function recordUserDownload(entry: UserDownload): void {
	entries.set(entry.id, entry);
	if (entries.size > MAX_ENTRIES) {
		// Maps iterate in insertion order — the first key is the oldest entry.
		// Never evict one still in flight; skip forward to the oldest settled.
		for (const [id, e] of entries) {
			if (e.state !== "progressing") { entries.delete(id); break; }
		}
	}
}

export function updateUserDownload(
	id: string,
	patch: Partial<Pick<UserDownload, "bytes" | "totalBytes" | "state" | "doneAt">>,
): void {
	const entry = entries.get(id);
	if (entry) Object.assign(entry, patch);
}

/** Newest first — panel display order. */
export function listUserDownloads(): UserDownload[] {
	return [...entries.values()].reverse();
}

/** Only registry-known ids resolve to an openable path (IPC safety boundary). */
export function userDownloadPath(id: string): string | null {
	return entries.get(id)?.savePath ?? null;
}

export function _resetUserDownloadsForTest(): void {
	entries.clear();
}
