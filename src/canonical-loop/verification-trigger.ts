/**
 * Verification trigger — the keystone observer of the verification-invariants
 * campaign.
 *
 * Always-on observer on the canonical event seam (projectCanonicalEvent,
 * event-emitter.ts), wired beside cost-recording.ts and
 * trash-scope-observer.ts. When ANY op SUCCEEDS — a delegated task or an
 * interactive chat/voice turn (see CHAT TURNS below) — in a session that
 * (a) ingested external content (data-lineage/external.ts — untrusted off-box
 * figures flowed into this task) and (b) created persistent deliverables
 * (data-lineage/task-artifacts.ts, filtered to DELIVERABLE_EXTENSIONS) that
 * CHANGED since the last verification, an independent model is eventually
 * asked to re-acquire the load-bearing values and report a first-line VERDICT.
 *
 * "Eventually" is the whole design and it lives next door:
 * verification-spend.ts owns the three bounds — artifact-set fingerprint
 * (which files), one live verifier per session (concurrency), and the
 * session-idle debounce (COUNT). This module decides only whether an event is
 * a CANDIDATE; the spend module decides whether a candidate buys a model run,
 * and it does not submit until the session has gone quiet. Read its header for
 * the count bug that shape exists to prevent.
 *
 * CHAT TURNS ARE ELIGIBLE. Condition 2 once excluded interactive host turns
 * (op-store.isInteractiveHostOpType) as "a reply turn ending, not a task
 * ending". That cost the tier its MOST COMMON case and the incident class that
 * motivated it: a deliverable built entirely inside a conversation never
 * reached the trigger at all. The exclusion is gone; every other condition is
 * unchanged. The honest statement of what it costs has to name BOTH chat
 * cases, not just the free one: a turn that changes no deliverable submits
 * nothing (fingerprint), and a turn that EDITS one only re-arms the quiet
 * period (debounce). Real semantics either way: ONE verification per quiet
 * period, covering everything that changed since the last one.
 *
 * PER-TURN COST is the other thing to bound, since a chat session's terminal
 * fires on every turn, and the guard order below is sorted by it. Through
 * guard 5 a no-op turn costs only Map/Set lookups on top of the single readOp
 * every observer on this seam already pays. Two guards touch the filesystem:
 * the fingerprint (statSync per session deliverable, reached only in an
 * already-armed session) and the one-live-verifier scan (readOp = existsSync +
 * readFileSync + JSON.parse, per LIVE peer op). The fingerprint runs FIRST on
 * purpose — it is the guard that says "nothing changed" on essentially every
 * conversational turn, so the per-peer reads are never paid on the common
 * path. Behaviour-preserving because the fingerprint is RECORDED only at
 * submit, so a blocked delta survives. Pinned in
 * verification-trigger-chat.test.ts.
 *
 * The verification op is a NORMAL background op for the runtime, but the
 * user never sees it as one: session-bridge-observer.ts routes it apart from
 * every worker surface (no AGENTS card, no progress, no inbox item, no "that
 * op just finished"). A DISCREPANCIES verdict submits a correction
 * (verification-correct.ts) whose landing the user hears as one line; only a
 * correction that cannot be made reaches the agent as a rework instruction.
 * Confirmed, unverifiable and failed passes are logged and nothing more. The
 * corrected file is a changed deliverable, so it is re-verified; that second
 * pass never corrects again (session-bridge-verification.ts).
 *
 * Guard order, cheapest discriminator first (the non-terminal-event path is
 * exactly ONE property check):
 *   1. event type: only `state_changed`, and only `to: "succeeded"`.
 *   2. op type: not VERIFICATION_OP_TYPE itself — the recursion guard (belted
 *      by the verifier's own worker-scoped session and the hard budget the
 *      submit stamps) — and not REVIEW_PUBLISH_OP_TYPE, the pipeline's other
 *      fresh-context pass. NOT filtered on interactive host turns any more:
 *      see CHAT TURNS.
 *   3. session facts, all in-memory: binding resolvable (Map), external
 *      ingestion recorded (Set), at least one deliverable-extension artifact
 *      (Set spread + extname filter).
 *   4. the `verifyDeliverables` runtime setting, read live via
 *      getRuntimeConfig (memoized in config.ts, already in this seam's static
 *      import graph — so it costs nothing).
 *   5. in-flight-submission flag (Set).
 *   6. changed-artifact fingerprint — statSync per session deliverable.
 *   7. one-live-verifier scan — readOp per LIVE peer op, the only per-peer
 *      DISK cost, deliberately last.
 *   8. arm/re-arm the session-idle debounce. Nothing is submitted and no
 *      fingerprint recorded here — both happen when the window elapses.
 *
 * ORDER-SENSITIVE: wired BEFORE the session-bridge observer in
 * projectCanonicalEvent (same reason as trash-scope-observer): the bridge's
 * terminal branch releases the op↔session binding, after which getSessionForOp
 * / listOpsForSession come back empty. The debounce entry captures the session
 * id at arm time, so a window that outlives the binding still submits.
 *
 * Pure instrumentation — never throws, never blocks the op terminal path
 * (cost-recording posture).
 */
import { getRuntimeConfig } from "../config.js";
import { readOp } from "../ops/op-store.js";
import { getSessionForOp } from "../ops/session-bridge.js";
import { hasExternalIngestion } from "../data-lineage/external.js";
import { listTaskArtifacts } from "../data-lineage/task-artifacts.js";
import {
	VERIFICATION_OP_TYPE,
	armVerificationDebounce,
	artifactSignature,
	checkBeforeDone,
	changedDeliverables,
	hasLiveVerifier,
	hasPendingSubmission,
	isDeliverablePath,
} from "./verification-spend.js";
import { REVIEW_PUBLISH_OP_TYPE } from "./publish-review-verdict.js";
import { OP_TYPE } from "../ops/op-types.js";
import { lastFigureCheckText } from "./figure-check-note.js";
import type { CanonicalEvent } from "./types.js";
import type { Op } from "../ops/types.js";

import { createLogger } from "../logger.js";
const logger = createLogger("canonical-loop.verification-trigger");

// The pass's vocabulary and its test seams live in verification-spend.ts. They
// are re-exported here because this module is the campaign's entry point and
// every consumer already reaches for it by that name.
export {
	VERIFICATION_OP_TYPE,
	DELIVERABLE_EXTENSIONS,
	VERIFICATION_DEBOUNCE_MS,
	isDeliverablePath,
	cancelAllVerificationDebounces,
	_setVerificationSubmitterForTests,
	_setVerificationDebounceMsForTests,
	_resetVerificationSpendForTests as _resetVerificationTriggerForTests,
} from "./verification-spend.js";
export type { VerificationSubmitInput } from "./verification-spend.js";

let warnedOnce = false;

export function recordVerificationTrigger(event: CanonicalEvent, sessionOverride?: string): void {
	try {
		if (event.type !== "state_changed") return;
		if (((event.body ?? {}) as Record<string, unknown>).to !== "succeeded") return;

		const op = readOp(event.opId);
		// Unreadable op -> type unknowable -> do nothing (fail toward silence;
		// a verification pass must never be the thing that guesses).
		if (!op?.type) return;
		// Same session resolution as the sibling observers: relay-projected
		// events hand an explicit session; everything else resolves through
		// the submit-time tracking (still bound -- we run before the bridge).
		const sessionId = sessionOverride ?? getSessionForOp(event.opId);
		// A finished correction changed a deliverable: this re-verifies it
		// (the proof the correction took); that pass never corrects again.
		const due = deliverablesToCheck(op, sessionId, { includeCorrection: true });
		if (!due) return;
		// Arm the quiet period rather than submitting. `current` is the map
		// this terminal observed; it becomes the recorded fingerprint only when
		// the window elapses and the verification actually goes out.
		armVerificationDebounce(due.sessionId, op, due.current, due.delta);
	} catch (e) {
		if (!warnedOnce) {
			warnedOnce = true;
			logger.warn(`[verify] event hook failed (further suppressed): ${(e as Error).message}`);
		}
	}
}

/** The op types whose own ending is never checked: the passes themselves. */
const CORRECTION_OP_TYPE: string = OP_TYPE.correctDeliverable;
const NEVER_CHECKED = new Set<string>([VERIFICATION_OP_TYPE, REVIEW_PUBLISH_OP_TYPE, CORRECTION_OP_TYPE]);

/**
 * Whether this op's ending should check its session's deliverables, and which
 * changed: the one decision both the quiet-period trigger above and the
 * before-done check below make, so they cannot disagree. Null when not (each
 * reason logged); guard order cheapest first, as the module header lays out.
 * A correction's ending re-verifies its corrected file through the quiet
 * period (`includeCorrection`), never before its own "done": waiting there
 * would hold the correction, and the reply waiting on it, for a second pass.
 */
export function deliverablesToCheck(op: Op, sessionId: string | undefined, opts: { includeCorrection?: boolean } = {}):
	{ sessionId: string; current: Map<string, string>; delta: string[] } | null {
	// The verifier's own type and the pre-publish review never buy a pass
	// (recursion guard); a correction does, through the quiet period only.
	if (NEVER_CHECKED.has(op.type) && !(opts.includeCorrection && op.type === CORRECTION_OP_TYPE)) {
		logger.debug(`[verify] skip ${op.id}: ${op.type} is a pass of its own (recursion guard)`);
		return null;
	}
	if (!sessionId) {
		logger.debug(`[verify] skip ${op.id}: no session binding`);
		return null;
	}
	if (!hasExternalIngestion(sessionId)) {
		logger.debug(`[verify] skip ${op.id}: session ${sessionId} ingested no external content`);
		return null;
	}
	const deliverables = listTaskArtifacts(sessionId).filter(isDeliverablePath);
	if (deliverables.length === 0) {
		logger.debug(`[verify] skip ${op.id}: no deliverable-extension artifacts in session ${sessionId}`);
		return null;
	}
	if (!getRuntimeConfig().verifyDeliverables) {
		logger.debug(`[verify] skip ${op.id}: verifyDeliverables setting is off`);
		return null;
	}
	// A submission already in flight for this session -- O(1), so it comes
	// before anything that touches the filesystem.
	if (hasPendingSubmission(sessionId)) {
		logger.debug(`[verify] skip ${op.id}: verification submission already in flight for ${sessionId}`);
		return null;
	}
	// ARTIFACT-SET FINGERPRINT. THE per-turn exit for a chat session -- a
	// conversational turn that wrote nothing stops here, before any
	// per-peer op read.
	const { current, delta } = changedDeliverables(sessionId, deliverables);
	if (current.size === 0) {
		logger.debug(`[verify] skip ${op.id}: no deliverable currently readable on disk`);
		return null;
	}
	if (delta.length === 0) {
		logger.debug(`[verify] skip ${op.id}: deliverable set unchanged since last verification`);
		return null;
	}
	// ONE LIVE VERIFIER PER SESSION -- the DISK half, reached only on a real
	// delta. A tracked running/pending verifier blocks WITHOUT recording the
	// fingerprint, so this delta survives to the next terminal.
	if (hasLiveVerifier(sessionId, op.id)) {
		logger.debug(`[verify] skip ${op.id}: a verification op is already live for ${sessionId}`);
		return null;
	}
	return { sessionId, current, delta };
}

/**
 * The before-done check (the completion chain's figures-verify gate): when
 * this turn's ending would check its deliverables, check them now and wait,
 * so the reply the user reads covers the checked file. Returns what happened,
 * or "skipped" when nothing was due.
 */
export async function checkFiguresBeforeDone(op: Op, signal?: AbortSignal): Promise<"checked" | "timed-out" | "not-submitted" | "skipped"> {
	try {
		const due = deliverablesToCheck(op, getSessionForOp(op.id));
		if (!due) return "skipped";
		return await checkBeforeDone(due.sessionId, op, due.current, due.delta, { signal });
	} catch (e) {
		logger.warn(`[verify] before-done check failed for ${op.id}: ${(e as Error).message}`);
		return "skipped";
	}
}

/** What a check the user asked for came to, and the note it left on the reply. */
export interface RequestedFigureCheck {
	result: "checked" | "timed-out" | "not-submitted" | "busy" | "off" | "no-files";
	note: string | null;
}

/**
 * A figures check the user asked for: "check the rest" after a note said
 * "16 of 40", or every figure from the start ("fact-check each slide"), run
 * from the figures_check tool inside the turn. It runs like the before-done
 * check, held to the same wait, with the scope the user asked for, and
 * records the files as checked so the turn's own ending does not check them
 * again. The setting still decides: off means no check, said so.
 */
export async function checkFiguresOnRequest(op: Op, paths: string[], scope: "rest" | "all", signal?: AbortSignal): Promise<RequestedFigureCheck> {
	const sessionId = getSessionForOp(op.id) ?? op.sessionId;
	if (!getRuntimeConfig().verifyDeliverables) return { result: "off", note: null };
	const files = paths.filter((p) => artifactSignature(p) !== null);
	if (!sessionId || files.length === 0) return { result: "no-files", note: null };
	if (hasPendingSubmission(sessionId) || hasLiveVerifier(sessionId, null)) return { result: "busy", note: null };
	const { current } = changedDeliverables(sessionId, files);
	const result = await checkBeforeDone(sessionId, op, current, files, { scope, signal });
	return { result, note: lastFigureCheckText(sessionId) };
}
