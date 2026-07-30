/**
 * browser-partition-net — pure networking helpers for the per-partition egress
 * path (desktop/src/browser-partition.ts). No Electron session state and no
 * cross-module seams live here, so it is unit-testable in isolation and keeps
 * browser-partition.ts focused on the hardening orchestration.
 *
 * Contents: the per-hop decision LRU cache, the outbound-body extractor for the
 * taint scan, and the hardening-CSP header builder. Deliberately free of any
 * Electron/config runtime import (only an erased UploadData type) so it stays a
 * pure, standalone-testable leaf under the desktop vitest config.
 */

import type { UploadData } from "electron";

// ── Hardening CSP (top-level document) ─────────
// Mirror of src/browser/csp-policy.ts buildAgentCsp() — desktop/src is a separate
// CJS project that can't import from src/. A fixed 3-directive literal with no
// logic, so there is nothing to drift; keep in sync if that string ever changes.
export const AGENT_HARDENING_CSP = "object-src 'none'; base-uri 'self'; frame-ancestors 'none'";

/**
 * Return the responseHeaders with our hardening CSP APPENDED as an additional
 * Content-Security-Policy value (never a replacement) so Chromium enforces the
 * intersection — it can only tighten. Existing headers are preserved; an existing
 * CSP under any casing is appended to. Caller gates this to the MAIN-frame
 * document (frame-ancestors on a sub-frame would refuse legit embeds).
 */
export function buildHardeningCspHeaders(
	responseHeaders: Record<string, string[]> | undefined,
): Record<string, string[]> {
	const headers: Record<string, string[]> = { ...(responseHeaders ?? {}) };
	let key = "Content-Security-Policy";
	for (const k of Object.keys(headers)) {
		if (k.toLowerCase() === "content-security-policy") { key = k; break; }
	}
	headers[key] = [...(headers[key] ?? []), AGENT_HARDENING_CSP];
	return headers;
}

// ── Outbound body extraction (for the server-side taint scan) ─────────
// Only in-memory `bytes` segments are readable here — file/blob upload segments
// carry no bytes in the webRequest details (residual: a form file-upload of a
// secret file isn't scanned by this path; the agent's own tool egress-gate covers
// agent-driven file sends). Capped so a large upload can't bloat the IPC ask or
// the scan.
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

// ── Per-hop egress decision LRU cache ─────────
// Map iteration order is insertion order, so the first key is the least recently
// used. Only BODYLESS decisions are cached by the caller (a URL fully keys its
// own payload); body-bearing requests are recomputed each hop.
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
	decisionCache.delete(url); // refresh recency
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
