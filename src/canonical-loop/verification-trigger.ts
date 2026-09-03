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
 * The verification op is a NORMAL background op, deliberately NOT in
 * session-bridge-observer's SIDEBAR_SUPPRESSED_OP_TYPES: it nests under its
 * parent in the AGENTS panel (parentOpId), and a SUCCEEDED verdict rides the
 * ordinary bg_op_completed → pending-notifications channel so the agent
 * narrates it next turn (spoken as a headline, not a table — see
 * session-bridge-extractors.toSpokenCompletion). A FAILED verification is
 * quieted — harness noise, not a user-facing event.
 *
 * Guard order, cheapest discriminator first (the non-terminal-event path is
 * exactly ONE property check):
 *   1. event type: only `state_changed`, and only `to: "succeeded"`.
 *   2. op type: not VERIFICATION_OP_TYPE itself — the recursion guard (belted
 *      by the verifier's own worker-scoped session and the hard budget the
 *      submit stamps). NOT filtered on interactive host turns any more: see
 *      CHAT TURNS.
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
	changedDeliverables,
	hasLiveVerifier,
	hasPendingSubmission,
	isDeliverablePath,
} from "./verification-spend.js";
import type { CanonicalEvent } from "./types.js";

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
		// Unreadable op → type unknowable → do nothing (fail toward silence;
		// a verification pass must never be the thing that guesses).
		if (!op?.type) return;
		// Interactive host turns (chat_turn / voice_turn) are deliberately NOT
		// excluded here — see CHAT TURNS in the module header. The verifier's
		// own type is the only op type this observer skips.
		if (op.type === VERIFICATION_OP_TYPE) {
			logger.debug(`[verify] skip ${op.id}: verification op itself (recursion guard)`);
			return;
		}

		// Same session resolution as the sibling observers: relay-projected
		// events hand an explicit session; everything else resolves through
		// the submit-time tracking (still bound — we run before the bridge).
		const sessionId = sessionOverride ?? getSessionForOp(event.opId);
		if (!sessionId) {
			logger.debug(`[verify] skip ${op.id}: no session binding`);
			return;
		}
		if (!hasExternalIngestion(sessionId)) {
			logger.debug(`[verify] skip ${op.id}: session ${sessionId} ingested no external content`);
			return;
		}
		const deliverables = listTaskArtifacts(sessionId).filter(isDeliverablePath);
		if (deliverables.length === 0) {
			logger.debug(`[verify] skip ${op.id}: no deliverable-extension artifacts in session ${sessionId}`);
			return;
		}
		if (!getRuntimeConfig().verifyDeliverables) {
			logger.debug(`[verify] skip ${op.id}: verifyDeliverables setting is off`);
			return;
		}

		// A submission already in flight for this session — O(1), so it comes
		// before anything that touches the filesystem.
		if (hasPendingSubmission(sessionId)) {
			logger.debug(`[verify] skip ${op.id}: verification submission already in flight for ${sessionId}`);
			return;
		}

		// ARTIFACT-SET FINGERPRINT. THE per-turn exit for a chat session — a
		// conversational turn that wrote nothing stops here, before any
		// per-peer op read.
		const { current, delta } = changedDeliverables(sessionId, deliverables);
		if (current.size === 0) {
			logger.debug(`[verify] skip ${op.id}: no deliverable currently readable on disk`);
			return;
		}
		if (delta.length === 0) {
			logger.debug(`[verify] skip ${op.id}: deliverable set unchanged since last verification`);
			return;
		}

		// ONE LIVE VERIFIER PER SESSION — the DISK half, reached only on a real
		// delta. A tracked running/pending verifier blocks the arm WITHOUT
		// recording the fingerprint, so this delta survives to the next
		// terminal.
		if (hasLiveVerifier(sessionId, event.opId)) {
			logger.debug(`[verify] skip ${op.id}: a verification op is already live for ${sessionId}`);
			return;
		}

		// Arm the quiet period rather than submitting. `current` is the map
		// this terminal observed; it becomes the recorded fingerprint only when
		// the window elapses and the verification actually goes out.
		armVerificationDebounce(sessionId, op, current, delta);
	} catch (e) {
		if (!warnedOnce) {
			warnedOnce = true;
			logger.warn(`[verify] event hook failed (further suppressed): ${(e as Error).message}`);
		}
	}
}
