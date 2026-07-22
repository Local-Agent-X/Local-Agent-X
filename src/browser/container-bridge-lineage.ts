/**
 * container-bridge-lineage — cross-process forwarding of a container's
 * data-lineage state (taint + session canaries) to the host over the relay.
 *
 * WHY THIS EXISTS: when a container drives the in-app browser, its agent loop
 * runs in a SEPARATE process. Sensitive-read taint and session canaries accrue
 * in THAT process's module-level registries (data-lineage/taint.ts,
 * threat/canaries.ts). But the host answers the page-egress exfil scan
 * (browser/bridge-egress.ts → page-egress-taint.ts) against ITS OWN registries,
 * which are empty for a container-owned session. So a container that reads a
 * secret then browses to exfiltrate it was NOT caught — the very gate the
 * browser campaign hardened was blind to the container execution path.
 *
 * The fix mirrors the egress-worker pattern (a decision made where the registry
 * isn't → forward the registry to where the decision is), but across the
 * process boundary via the already-session-bound relay instead of a worker
 * postMessage. The container forwards its taint/canary deltas as they accrue;
 * the host applies them to ITS registries KEYED BY the forwarded session, so the
 * SAME canonical host scan (scanPageEgress) now sees the container's reads. No
 * scan/taint/canary logic is forked — this only carries state to the host.
 *
 * AUTHENTICATION / SESSION-BINDING: every frame is HMAC-authenticated with the
 * per-container relay token (proves container membership) and the host confines
 * each forwarded delta to the container's OWNING session (sessionBelongsToSession
 * against the relay's ownerSessionId). A container bound to session A therefore
 * cannot forward taint that attributes to an unrelated session B.
 */

import type { TaintEntry, TaintSource } from "../data-lineage/fingerprint.js";
import { sessionBelongsToSession } from "./bridge-perception.js";
import { exchange } from "./container-bridge-transport.js";

/** The host-side application seam for forwarded lineage state. The relay server
 *  (startBrowserContainerRelay) is handed this by the projection wiring, which
 *  binds it to the canonical host registries (setForwardedSessionTaint /
 *  registerSessionCanaries). Kept as an injected sink so the transport module
 *  stays free of a data-lineage/threat dependency. */
export interface BrowserRelayLineageSink {
	applyTaint(sessionId: string, entries: TaintEntry[]): void;
	applyCanaries(sessionId: string, canaries: string[]): void;
}

/** Wire shapes carried over the relay for lineage forwarding. */
export type RelayLineagePayload =
	| { kind: "taint"; sessionId: string; entries: TaintEntry[] }
	| { kind: "canaries"; sessionId: string; canaries: string[] };

const MAX_FORWARDED_SESSION_ID = 512;
const MAX_FORWARDED_ENTRIES = 4_096;
const MAX_FORWARDED_FINGERPRINTS = 4_096;
const MAX_FORWARDED_CANARIES = 256;
const TAINT_SOURCES: ReadonlySet<string> = new Set<TaintSource>([
	"sensitive_file", "secret", "memory", "web", "user_data",
]);
const FORWARD_TIMEOUT_MS = 5_000;

function assertForwardSessionId(sessionId: unknown): asserts sessionId is string {
	if (typeof sessionId !== "string" || sessionId.length < 1 || sessionId.length > MAX_FORWARDED_SESSION_ID) {
		throw new Error("invalid browser relay lineage session");
	}
}

// ── Container-side client ───────────────────────────────────────────────────

/** Forward this container's post-mutation taint entries for `sessionId` to the
 *  host (full-state delta, matching the taint subscribe seam). */
export async function relayForwardTaint(sessionId: string, entries: TaintEntry[]): Promise<void> {
	assertForwardSessionId(sessionId);
	await exchange({ kind: "taint", sessionId, entries } satisfies RelayLineagePayload, FORWARD_TIMEOUT_MS);
}

/** Forward this container's active canary set for `sessionId` to the host
 *  (full-state delta, matching the canary subscribe seam). */
export async function relayForwardCanaries(sessionId: string, canaries: string[]): Promise<void> {
	assertForwardSessionId(sessionId);
	await exchange({ kind: "canaries", sessionId, canaries } satisfies RelayLineagePayload, FORWARD_TIMEOUT_MS);
}

// ── Host-side validation + apply ────────────────────────────────────────────

function isForwardedTaintEntry(value: unknown): value is TaintEntry {
	if (value === null || typeof value !== "object") return false;
	const e = value as Record<string, unknown>;
	return typeof e.source === "string" && TAINT_SOURCES.has(e.source)
		&& typeof e.target === "string"
		&& typeof e.timestamp === "number"
		&& typeof e.runId === "string"
		&& typeof e.complete === "boolean"
		&& Array.isArray(e.fingerprints)
		&& e.fingerprints.length <= MAX_FORWARDED_FINGERPRINTS
		&& e.fingerprints.every(fp => typeof fp === "string");
}

/** Structurally validate an inbound lineage payload (post-frame-auth) before it
 *  reaches a host registry. Bounds every array so a compromised container can't
 *  balloon host memory; rejects malformed entries outright. */
export function assertLineagePayload(payload: unknown): asserts payload is RelayLineagePayload {
	if (!payload || typeof payload !== "object") throw new Error("invalid browser relay lineage payload");
	const p = payload as Record<string, unknown>;
	assertForwardSessionId(p.sessionId);
	if (p.kind === "taint") {
		if (!Array.isArray(p.entries) || p.entries.length > MAX_FORWARDED_ENTRIES || !p.entries.every(isForwardedTaintEntry)) {
			throw new Error("invalid browser relay taint payload");
		}
		return;
	}
	if (p.kind === "canaries") {
		if (!Array.isArray(p.canaries) || p.canaries.length > MAX_FORWARDED_CANARIES
			|| !p.canaries.every(c => typeof c === "string" && c.length <= 512)) {
			throw new Error("invalid browser relay canary payload");
		}
		return;
	}
	throw new Error("invalid browser relay lineage payload");
}

/**
 * Apply a forwarded lineage payload to the host registries via `sink`, confined
 * to the relay's owning session. The payload must already be shape-validated
 * (assertLineagePayload, run in the relay's validate stage). Throws — refusing
 * the whole frame — when the forwarded session is not owned by this relay, which
 * is what keeps container A from tainting/attributing to session B.
 */
export function applyForwardedLineage(
	payload: RelayLineagePayload,
	ownerSessionId: string,
	sink: BrowserRelayLineageSink | undefined,
): void {
	if (!sessionBelongsToSession(payload.sessionId, ownerSessionId)) {
		throw new Error("browser relay lineage is not owned by this session");
	}
	if (!sink) return;
	if (payload.kind === "taint") sink.applyTaint(payload.sessionId, payload.entries);
	else sink.applyCanaries(payload.sessionId, payload.canaries);
}
