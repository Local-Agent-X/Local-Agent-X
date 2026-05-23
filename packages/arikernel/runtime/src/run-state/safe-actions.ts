/**
 * Action classification for restricted-mode gating and escalation ranking.
 */

import { categorizeAction } from "@arikernel/core";

/** Risk ordering for tool classes — used by escalation denial sticky flag. */
export const TOOL_CLASS_RISK_MAP: Record<string, number> = {
	http: 1,
	database: 2,
	file: 3,
	shell: 5,
};

export const MAX_EVENT_WINDOW = 20;

/**
 * Check if a (toolClass, action) pair is safe read-only.
 *
 * Uses the canonical action taxonomy from @arikernel/core so new actions
 * that aren't explicitly registered as "read" are blocked (fail-closed).
 *
 * HTTP GET/HEAD are allowed for content ingress (fetching pages to read).
 * Suspicious GET exfil patterns (large query strings, data-bearing params)
 * are caught separately by isSuspiciousGetExfil() in the pipeline.
 *
 * True egress methods (POST/PUT/PATCH/DELETE) are always blocked in quarantine.
 */
export function isSafeReadOnlyAction(toolClass: string, action: string): boolean {
	return categorizeAction(toolClass, action) === "read";
}

/**
 * Check if an HTTP action is a true egress (outbound write) attempt.
 * Only write methods are egress. GET/HEAD are ingress (content fetch).
 * Suspicious GET-based exfil is detected separately by isSuspiciousGetExfil().
 */
export function isEgressAction(action: string): boolean {
	return ["post", "put", "patch", "delete"].includes(action);
}
