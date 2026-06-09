/**
 * Per-hostname egress byte accounting for slow-drip exfiltration detection.
 *
 * Tracks cumulative query-string and encoded URL-path bytes per destination
 * host so that exfil spread across many small GETs accumulates against a
 * per-run ceiling even when each individual request stays under budget (H11).
 *
 * Pure helpers that operate on a caller-owned hostname → record map; the
 * RunStateTracker instance methods delegate here so their public signatures
 * stay stable while the budget logic lives in one cohesive place.
 */

import { pathDripEncodedBytes } from "./exfil-detection.js";
import type { HostnameEgressRecord } from "./types.js";

export type EgressMap = Map<string, HostnameEgressRecord>;

/**
 * Per-request budget of encoded-looking URL-path bytes to a non-allowlisted
 * host (H11). A single GET whose path carries more than this many hex/base64
 * bytes is the request equivalent of an oversized query string.
 */
export const MAX_ENCODED_PATH_BYTES_PER_REQUEST = 48;

/**
 * Per-run budget of cumulative encoded-looking URL-path bytes to a single
 * non-allowlisted host (H11). This is the slow-drip backstop: many small hex
 * path segments spread across several GETs accumulate against this ceiling
 * even when each individual request stays under the per-request budget.
 */
export const MAX_ENCODED_PATH_BYTES_PER_HOST = 96;

/**
 * Fetch-or-create the cumulative egress record for a URL's hostname and bump
 * its request count. Returns undefined for unparseable URLs.
 */
export function egressRecordFor(map: EgressMap, url: string): HostnameEgressRecord | undefined {
	let hostname: string;
	try {
		hostname = new URL(url).hostname;
	} catch {
		return undefined;
	}
	const record = map.get(hostname) ?? {
		totalQueryBytes: 0,
		totalPathPayloadBytes: 0,
		requestCount: 0,
	};
	record.requestCount++;
	map.set(hostname, record);
	return record;
}

/** Record cumulative HTTP GET egress bytes for a hostname. */
export function recordHttpGetEgress(map: EgressMap, url: string): void {
	const record = egressRecordFor(map, url);
	if (!record) return;
	try {
		record.totalQueryBytes += new URL(url).search.length;
	} catch {
		/* ignore invalid URLs */
	}
}

/**
 * Record encoded-looking URL-path bytes for a GET/HEAD to a non-allowlisted
 * host and decide whether the request must be blocked as path-drip exfil.
 *
 * Returns true when ANY of:
 *   - `strict` is set and the request carries ANY encoded path bytes, OR
 *   - this single request's encoded path bytes exceed the per-request budget, OR
 *   - the cumulative encoded path bytes to this host exceed the per-run budget.
 *
 * `strict` mirrors the query-GET budget=0 rule: once a sensitive read has been
 * confirmed, the tolerance for encoded path bytes to a non-allowlisted host
 * drops to zero, so even a single tiny hex segment is blocked (used by the
 * restricted-mode gate after quarantine).
 *
 * Allowlisted hosts are exempt (record nothing, return false) so legitimate
 * GETs to trusted analytics/CDN hosts are never throttled. This is the gate
 * that finally READS the per-host cumulative accounting the tracker records.
 */
export function recordEncodedPathEgress(
	map: EgressMap,
	url: string,
	isAllowlisted: (hostname: string) => boolean,
	strict = false,
): boolean {
	let hostname: string;
	try {
		hostname = new URL(url).hostname;
	} catch {
		return false;
	}
	if (isAllowlisted(hostname)) return false;

	const encodedBytes = pathDripEncodedBytes(url);
	const record = egressRecordFor(map, url);
	if (!record) return false;
	record.totalPathPayloadBytes += encodedBytes;

	if (strict && encodedBytes > 0) return true;
	if (encodedBytes > MAX_ENCODED_PATH_BYTES_PER_REQUEST) return true;
	if (record.totalPathPayloadBytes > MAX_ENCODED_PATH_BYTES_PER_HOST) return true;
	return false;
}

/** Total cumulative query-string bytes across all hostnames. */
export function totalEgressQueryBytes(map: EgressMap): number {
	let total = 0;
	for (const record of map.values()) {
		total += record.totalQueryBytes;
	}
	return total;
}
