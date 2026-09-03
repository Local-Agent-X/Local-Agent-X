/**
 * Verification SPEND MODEL — what a verification pass costs, and when one is
 * allowed to happen.
 *
 * Split out of verification-trigger.ts, which had grown two responsibilities:
 * deciding whether an event is a CANDIDATE (the observer's guard chain, still
 * there) and deciding whether a candidate actually BUYS a model run (here).
 * This module owns the pass's vocabulary — the op type, what counts as a
 * deliverable — plus every mechanism that bounds spend, because they are one
 * design and reasoning about them apart from each other is how the count bug
 * below got shipped. Dependency runs ONE way: verification-trigger.ts imports
 * this; nothing here imports the trigger.
 *
 * THE THREE BOUNDS, and what each one actually bounds:
 *
 *   1. ARTIFACT-SET FINGERPRINT — bounds WHICH files. At submit time the
 *      (path → mtime:size) signature map of the session's deliverables is
 *      recorded; a later terminal counts only paths whose signature is new or
 *      changed, and the brief carries only that delta. Unchanged set → skip.
 *      In-memory, module-lifetime (the emitter's EMITTED_ERRORS posture): a
 *      restart re-verifies each set once, which is acceptable.
 *
 *   2. ONE LIVE VERIFIER PER SESSION — bounds CONCURRENCY. A running/pending
 *      VERIFICATION_OP_TYPE op tracked in the session, plus an in-process
 *      pending flag covering the async submission window, collapses bursts.
 *      It does NOT bound how many verifications a session buys over time.
 *
 *   3. SESSION-IDLE DEBOUNCE — bounds COUNT, and this is the one the first
 *      two do not give you. The fingerprint counts SAVED VERSIONS: a user
 *      iterating on one spreadsheet across 20 chat turns changes mtime:size
 *      20 times, so 1 and 2 together still bought 20 verifications, serially.
 *      Worse than the spend, the verdict on v7 got NARRATED (pending
 *      notification + proactive speech + idle nudge) while the user was on v9
 *      — interrupting the iteration loop with findings about a cell they had
 *      already fixed. So a changed set does not submit: it (re)arms a
 *      per-session quiet-period timer, each new delta cancels and re-arms it,
 *      and when the window finally elapses quietly ONE verification goes out
 *      over the UNION of everything that changed since the last one. The
 *      version the user STOPPED at is the version that gets verified.
 *
 * The fingerprint is recorded at SUBMIT, never at arm. Nothing is swallowed by
 * a process death, a flipped setting, or a verifier going live mid-window: the
 * accumulated delta simply stays undelivered and the next terminal re-detects
 * it (worst case, one redundant re-verify).
 */
import { statSync } from "node:fs";
import { extname } from "node:path";
import { getRuntimeConfig } from "../config.js";
import { readOp } from "../ops/op-store.js";
import { listOpsForSession } from "../ops/session-bridge.js";
import type { Op } from "../ops/types.js";

import { createLogger } from "../logger.js";
const logger = createLogger("canonical-loop.verification-spend");

/** The verification op's type — the persisted recursion-guard marker. Dispatch
 *  is NOT type-keyed (runtime.ts resolves adapter factories per op id, else
 *  per lane), so a dedicated type is safe; it is also what the AGENTS panel
 *  keys per-type icons on, what the observer's failed-verification quieting
 *  discriminates on, and what routes a verdict to its spoken headline. It must
 *  stay OUT of session-bridge-observer's SIDEBAR_SUPPRESSED_OP_TYPES so the op
 *  surfaces like any background worker. */
export const VERIFICATION_OP_TYPE = "verify_deliverable";

/** File extensions that count as persistent deliverables worth an independent
 *  verification pass. Lowercase, dot-prefixed; matched case-insensitively. */
export const DELIVERABLE_EXTENSIONS: ReadonlySet<string> = new Set([
	".xlsx", ".csv", ".docx", ".pdf", ".pptx", ".md",
]);

/** Is this artifact path a deliverable (by DELIVERABLE_EXTENSIONS)? */
export function isDeliverablePath(path: string): boolean {
	return DELIVERABLE_EXTENSIONS.has(extname(path).toLowerCase());
}

export interface VerificationSubmitInput {
	parentOp: Op;
	sessionId: string;
	/** ONLY the new/changed deliverables — the brief's scope. */
	deliverables: string[];
}

export type VerificationSubmitter = (input: VerificationSubmitInput) => Promise<boolean>;

/**
 * The quiet period a changed deliverable set must survive before its
 * verification is submitted, reasoned against ops/idle-nudge.ts — the in-repo
 * precedent for "has this session gone quiet?", already on this code path.
 *   LOWER BOUND: it must outlast an ITERATION gap. In an edit loop the user
 *   reads the reply and types the next correction in seconds to a few tens of
 *   seconds; anything shorter fires mid-loop, the exact failure this exists to
 *   prevent. A turn that does NOT clear 45s is a genuine pause.
 *   UPPER BOUND: it must finish inside idle-nudge's IDLE_NUDGE_MS (120s) —
 *   this repo's own "the user has gone idle" line, and the moment a verdict
 *   gets ANNOUNCED. Submitting at 45s leaves ~75s for the verifier to run, so
 *   the debounce moves when we START, not when the user hears; the verdict
 *   still rides the next turn's drain or that same nudge. At or past 120s it
 *   would fall behind its own announcement point.
 * ONE PATH FOR BOTH LANES — a delegated parent is not exempt. Multi-op
 * pipelines churn one deliverable the same way (op A writes the sheet, op B
 * enriches it), so the count argument holds there too, and nothing waits
 * synchronously on a background verdict: surfacing is next-turn/nudge-gated on
 * every lane. A second immediate-fire path would be a second set of semantics
 * to reason about and test, for no gain.
 */
export const VERIFICATION_DEBOUNCE_MS = 45_000;

interface DebouncedVerification {
	timer: NodeJS.Timeout;
	/** UNION of every deliverable changed since the last SUBMITTED
	 *  verification — the whole edit run, deduped by path. */
	changed: Set<string>;
	/** Signature map observed at the LAST arming terminal, written to
	 *  VERIFIED_ARTIFACTS only when the submit fires. */
	signatures: Map<string, string>;
	/** Most recent qualifying parent — lineage and the brief's parent-task line
	 *  come from the turn the user STOPPED at. */
	parentOp: Op;
}

/** sessionId → the signature map recorded at its last verification SUBMIT. */
const VERIFIED_ARTIFACTS = new Map<string, Map<string, string>>();

/** Sessions with a submission in flight — covers the async window between fire
 *  and the submitted op appearing in listOpsForSession. */
const PENDING_VERIFIER_SESSIONS = new Set<string>();

/** sessionId → its armed quiet period and the delta accumulating under it. At
 *  most one entry per session: a new delta cancels and re-arms. */
const DEBOUNCED = new Map<string, DebouncedVerification>();

let submitterOverride: VerificationSubmitter | null = null;
let debounceMsOverride: number | null = null;
let warnedOnce = false;

function warnOnce(what: string, e: unknown): void {
	if (warnedOnce) return;
	warnedOnce = true;
	logger.warn(`[verify] ${what} (further suppressed): ${(e as Error).message}`);
}

function submitter(): VerificationSubmitter {
	return submitterOverride
		?? (async (input) => (await import("./verification-submit.js")).submitVerificationOp(input));
}

/** Current on-disk signature for one deliverable, or null when it is gone or
 *  unreadable (a vanished file is not currently verifiable — dropped from the
 *  set rather than guessed at). */
export function artifactSignature(path: string): string | null {
	try {
		const s = statSync(path);
		return `${s.mtimeMs}:${s.size}`;
	} catch { return null; }
}

/** The signature map for a session's deliverables right now, and the subset
 *  whose signature is new or changed since the last SUBMITTED verification. */
export function changedDeliverables(sessionId: string, deliverables: string[]): { current: Map<string, string>; delta: string[] } {
	const current = new Map<string, string>();
	for (const path of deliverables) {
		const sig = artifactSignature(path);
		if (sig !== null) current.set(path, sig);
	}
	const lastVerified = VERIFIED_ARTIFACTS.get(sessionId);
	const delta = [...current.keys()].filter((path) => lastVerified?.get(path) !== current.get(path));
	return { current, delta };
}

/** Is a submission already in flight for this session? O(1), so callers reach
 *  it before anything that touches the filesystem. */
export function hasPendingSubmission(sessionId: string): boolean {
	return PENDING_VERIFIER_SESSIONS.has(sessionId);
}

/** Is a verification already running or pending for this session? The only
 *  per-peer DISK cost on the path (readOp each), so callers reach it last. */
export function hasLiveVerifier(sessionId: string, excludeOpId: string | null): boolean {
	return listOpsForSession(sessionId).some((id) => {
		if (id === excludeOpId) return false; // the terminating parent itself
		const peer = readOp(id);
		return !!peer
			&& peer.type === VERIFICATION_OP_TYPE
			&& (peer.status === "running" || peer.status === "pending");
	});
}

/**
 * (Re)arm the session's quiet period. A new delta CANCELS the running timer
 * and starts a fresh window over the accumulated union — the idle-nudge
 * cancel-and-reschedule shape. Nothing is submitted and no fingerprint is
 * recorded here; both happen in fire(), so an edit run costs ONE verification
 * however many turns it spans. Unref'd — never holds the process open.
 */
export function armVerificationDebounce(sessionId: string, parentOp: Op, signatures: Map<string, string>, changed: string[]): void {
	const prior = DEBOUNCED.get(sessionId);
	if (prior) clearTimeout(prior.timer);
	const merged = prior?.changed ?? new Set<string>();
	for (const path of changed) merged.add(path);
	const windowMs = debounceMsOverride ?? VERIFICATION_DEBOUNCE_MS;
	const timer = setTimeout(() => fireVerificationDebounce(sessionId), windowMs);
	timer.unref?.();
	DEBOUNCED.set(sessionId, { timer, changed: merged, signatures, parentOp });
	logger.debug(`[verify] debounce ${prior ? "re-armed" : "armed"} for ${sessionId}: ${merged.size} changed deliverable(s), ${windowMs}ms quiet period`);
}

/**
 * The quiet period elapsed — submit ONE verification over everything that
 * changed during it. Re-checks the two gates that can flip while the timer
 * runs (the setting; a verifier going live); on either the entry is dropped
 * WITHOUT recording the fingerprint, so the delta is re-detected by the next
 * terminal exactly as an arm-time block would be.
 */
function fireVerificationDebounce(sessionId: string): void {
	const entry = DEBOUNCED.get(sessionId);
	DEBOUNCED.delete(sessionId);
	if (!entry) return;
	try {
		if (!getRuntimeConfig().verifyDeliverables) {
			logger.debug(`[verify] debounce fired for ${sessionId} but the setting is now off`);
			return;
		}
		if (PENDING_VERIFIER_SESSIONS.has(sessionId) || hasLiveVerifier(sessionId, null)) {
			logger.debug(`[verify] debounce fired for ${sessionId} but a verifier is live — delta survives to the next terminal`);
			return;
		}
		// Re-stat: a file deleted during the quiet period is not verifiable.
		const deliverables = [...entry.changed].filter((path) => artifactSignature(path) !== null);
		if (deliverables.length === 0) return;
		VERIFIED_ARTIFACTS.set(sessionId, entry.signatures);
		PENDING_VERIFIER_SESSIONS.add(sessionId);
		void submitter()({ parentOp: entry.parentOp, sessionId, deliverables })
			.catch((e) => warnOnce("submission failed", e))
			.finally(() => PENDING_VERIFIER_SESSIONS.delete(sessionId));
	} catch (e) {
		warnOnce("debounce fire failed", e);
	}
}

/** Drop every armed quiet period. Wired into the graceful-shutdown owner
 *  (server/lifecycle.ts registerShutdown) so a timer cannot fire into a
 *  tearing-down runtime; nothing is lost, because a fingerprint is only
 *  recorded once a verification actually submits. */
export function cancelAllVerificationDebounces(): void {
	for (const entry of DEBOUNCED.values()) clearTimeout(entry.timer);
	DEBOUNCED.clear();
}

/** Test-only: swap the submitter (null restores the lazy-import path). */
export function _setVerificationSubmitterForTests(fn: VerificationSubmitter | null): void {
	submitterOverride = fn;
}

/** Test-only: shorten the quiet period. End-to-end tests drive the REAL
 *  canonical loop, which needs real timers, so they cannot fake-advance the
 *  window — they shrink it instead. Unit tests fake timers and keep the real
 *  constant. Null restores it. */
export function _setVerificationDebounceMsForTests(ms: number | null): void {
	debounceMsOverride = ms;
}

/** Test-only: reset the warn-once latch, fingerprints, in-flight flags and
 *  every armed quiet period. */
export function _resetVerificationSpendForTests(): void {
	warnedOnce = false;
	VERIFIED_ARTIFACTS.clear();
	PENDING_VERIFIER_SESSIONS.clear();
	cancelAllVerificationDebounces();
}
