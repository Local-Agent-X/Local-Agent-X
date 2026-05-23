/**
 * Sensitive file path detection.
 */

import { normalizeInput } from "../unicode-safety.js";

/** Sensitive file path patterns that count toward sensitiveFileReadAttempts. */
const SENSITIVE_PATH_PATTERNS = [
	/\.ssh/i,
	/\.env/i,
	/\.aws/i,
	/credentials/i,
	/password/i,
	/secret/i,
	/\.gnupg/i,
	/id_rsa/i,
	/\.kube\/config/i,
	/token/i,
];

/** Check if a file path targets a sensitive location. NFKC-normalized to prevent homoglyph bypass. */
export function isSensitivePath(path: string): boolean {
	const normalized = normalizeInput(path);
	return SENSITIVE_PATH_PATTERNS.some((p) => p.test(normalized));
}
