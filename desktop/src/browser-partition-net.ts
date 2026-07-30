/**
 * Pure networking helpers for the shared in-app browser partition.
 * Session state and Electron orchestration stay in browser-partition.ts.
 */

import type { UploadData } from "electron";

const EGRESS_BODY_SCAN_CAP = 128 * 1024;

export function extractUploadBody(uploadData: UploadData[] | undefined): string | undefined {
	if (!uploadData || uploadData.length === 0) return undefined;
	const parts: string[] = [];
	let total = 0;
	for (const d of uploadData) {
		const bytes = d?.bytes;
		if (!bytes || bytes.length === 0) continue;
		const room = EGRESS_BODY_SCAN_CAP - total;
		if (room <= 0) break;
		const slice = bytes.length > room ? bytes.subarray(0, room) : bytes;
		parts.push(slice.toString("utf8"));
		total += slice.length;
	}
	return parts.length ? parts.join("") : undefined;
}

const CACHE_MAX_ENTRIES = 512;
const CACHE_TTL_MS = 30_000;
const decisionCache = new Map<string, { allowed: boolean; expiresAt: number }>();

export function cacheGet(url: string): boolean | null {
	const entry = decisionCache.get(url);
	if (!entry) return null;
	if (Date.now() > entry.expiresAt) {
		decisionCache.delete(url);
		return null;
	}
	decisionCache.delete(url);
	decisionCache.set(url, entry);
	return entry.allowed;
}

export function cacheSet(url: string, allowed: boolean): void {
	if (decisionCache.has(url)) decisionCache.delete(url);
	else if (decisionCache.size >= CACHE_MAX_ENTRIES) {
		const oldest = decisionCache.keys().next().value;
		if (oldest !== undefined) decisionCache.delete(oldest);
	}
	decisionCache.set(url, { allowed, expiresAt: Date.now() + CACHE_TTL_MS });
}

export function clearDecisionCache(): void {
	decisionCache.clear();
}
