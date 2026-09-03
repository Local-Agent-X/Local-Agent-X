/**
 * Verification trigger — the keystone observer of the verification-invariants
 * campaign.
 *
 * Always-on observer on the canonical event seam (projectCanonicalEvent,
 * event-emitter.ts), wired beside cost-recording.ts and
 * trash-scope-observer.ts. When ANY op SUCCEEDS — a delegated task or an
 * interactive chat/voice turn (see CHAT TURNS below) — in a session
 * that (a) ingested external content (data-lineage/external.ts — untrusted
 * off-box figures flowed into this task) and (b) created persistent
 * deliverables (data-lineage/task-artifacts.ts, filtered to
 * DELIVERABLE_EXTENSIONS) that CHANGED since the last verification, it
 * submits ONE background verification op whose task is buildVerificationBrief
 * over ONLY the new/changed deliverables — an independent model re-acquires
 * the load-bearing values and reports a first-line VERDICT.
 *
 * SPEND MODEL (the design center — both registries feeding this trigger are
 * sticky for the session's life, so without change-detection every later op
 * terminal in an armed session would re-verify the same unchanged files):
 *   - Artifact-set fingerprint: at submit time the (path → mtime:size)
 *     signature map of the session's deliverables is recorded per session; a
 *     later terminal fires only for paths whose signature is NEW or CHANGED,
 *     and the brief carries only that delta. Unchanged set → debug-log skip.
 *     In-memory, module-lifetime (same posture as the emitter's EMITTED_ERRORS
 *     ledger): a restart re-verifies each set once, which is acceptable.
 *   - One live verifier per session: any running/pending VERIFICATION_OP_TYPE
 *     op tracked in the session (plus an in-process pending flag covering the
 *     async submission window) collapses bursts; the next terminal's
 *     fingerprint check picks up the accumulated delta after it finishes.
 *   - The verifier itself runs under its OWN worker-scoped session
 *     (agent-op-<opId>, see verification-submit.ts), so its ingestion marks
 *     and its own artifact writes land in its own bucket and can never grow
 *     the parent session's deliverable set (no compounding).
 *
 * CHAT TURNS ARE ELIGIBLE. Condition 2 once excluded interactive host turns
 * (op-store.isInteractiveHostOpType) on the reasoning that a reply turn
 * ending is not a task ending. That reasoning cost the tier its MOST COMMON
 * case — and the incident class that motivated it: a deliverable built
 * entirely inside a conversation (the agent scrapes figures and writes the
 * spreadsheet in the same turn the user asked for it) never reached the
 * trigger at all. The exclusion is gone; every other condition is unchanged.
 * What makes it affordable is that the spend model above is FINGERPRINT-
 * keyed, not op-keyed: a chat session's terminal fires on every turn, but a
 * turn that changed no deliverable submits NOTHING, so N conversational
 * turns after one deliverable-producing turn cost exactly ONE verification.
 *
 * PER-TURN COST is therefore the thing to bound, and the guard order below
 * is sorted by it. Through guard 5 a no-op turn costs only Map/Set lookups
 * on top of the single readOp every observer on this seam already pays. The
 * two guards that touch the filesystem are the artifact-set fingerprint
 * (statSync per session deliverable — bounded by how many files the agent
 * created, and reached only in an ALREADY-ARMED session that both ingested
 * external content and wrote a deliverable) and the one-live-verifier scan
 * (readOp = existsSync + readFileSync + JSON.parse, per LIVE peer op in the
 * session). The fingerprint runs FIRST on purpose: it is the guard that says
 * "nothing changed" on essentially every conversational turn, so the
 * per-peer disk reads are never paid on the common path. Swapping the two is
 * behaviour-preserving because the fingerprint is only RECORDED once every
 * gate has passed — a delta a live verifier blocks stays unrecorded and the
 * next terminal picks it up. Pinned in verification-trigger-chat.test.ts.
 *
 * The verification op is a NORMAL background op, deliberately NOT in
 * session-bridge-observer's SIDEBAR_SUPPRESSED_OP_TYPES: it shows in the
 * AGENTS panel nested under its parent (parentOpId carries the lineage), and
 * a SUCCEEDED verdict rides the ordinary bg_op_completed →
 * pending-notifications channel so the agent narrates it on the next turn. A
 * FAILED verification is quieted (observer terminal branch) — harness noise,
 * not a user-facing event.
 *
 * Guard order, cheapest discriminator first (the non-terminal-event path is
 * exactly ONE property check):
 *   1. event type: only `state_changed`, and only `to: "succeeded"`.
 *   2. op type: not VERIFICATION_OP_TYPE itself — the recursion guard
 *      (belted by the verifier's own-session confinement above and the hard
 *      budget the submit stamps). NOT filtered on interactive host turns
 *      any more: see CHAT TURNS.
 *   3. session facts, all in-memory: binding resolvable (Map), external
 *      ingestion recorded (Set), at least one deliverable-extension artifact
 *      (Set spread + extname filter).
 *   4. the `verifyDeliverables` runtime setting, read live via
 *      getRuntimeConfig (memoized in config.ts; already in this seam's
 *      static import graph — workspace/paths.ts et al. — so it costs
 *      nothing).
 *   5. in-flight-submission flag (Set).
 *   6. changed-artifact fingerprint — statSync per session deliverable.
 *   7. one-live-verifier scan — readOp per LIVE peer op, the only per-peer
 *      DISK cost, deliberately last (see PER-TURN COST).
 *
 * ORDER-SENSITIVE: wired BEFORE the session-bridge observer in
 * projectCanonicalEvent (same reason as trash-scope-observer): the bridge's
 * terminal branch releases the op↔session binding, after which
 * getSessionForOp / listOpsForSession come back empty.
 *
 * Pure instrumentation — never throws, never blocks the op terminal path
 * (cost-recording posture). Submission is fire-and-forget async; the heavy
 * runtime construction (verification-submit.ts) loads lazily on the first
 * candidate.
 */
import { statSync } from "node:fs";
import { extname } from "node:path";
import { getRuntimeConfig } from "../config.js";
import { readOp } from "../ops/op-store.js";
import { getSessionForOp, listOpsForSession } from "../ops/session-bridge.js";
import { hasExternalIngestion } from "../data-lineage/external.js";
import { listTaskArtifacts } from "../data-lineage/task-artifacts.js";
import type { Op } from "../ops/types.js";
import type { CanonicalEvent } from "./types.js";

import { createLogger } from "../logger.js";
const logger = createLogger("canonical-loop.verification-trigger");

/** The verification op's type — the persisted recursion-guard marker. Dispatch
 *  is NOT type-keyed (runtime.ts resolves adapter factories per op id, else
 *  per lane), so a dedicated type is safe; it is also what the AGENTS panel
 *  keys per-type icons on, and the observer's failed-verification quieting
 *  discriminates on. It must stay OUT of session-bridge-observer's
 *  SIDEBAR_SUPPRESSED_OP_TYPES so the op surfaces like any background worker. */
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

/** sessionId → the (path → "mtimeMs:size") signature map recorded at the last
 *  verification submit. THE spend guard: a later terminal fires only for
 *  paths whose signature is new or changed. Recorded synchronously at fire
 *  time, so a double-projected terminal event recomputes an identical map and
 *  skips. Kept for the process's life; a submit that later fails does NOT
 *  roll it back — one attempt per changed set, no retry storms (the next
 *  actual change re-fires). */
const VERIFIED_ARTIFACTS = new Map<string, Map<string, string>>();

/** Sessions with a submission in flight — covers the async window between
 *  fire and the submitted op appearing in listOpsForSession (where the live
 *  check below takes over). */
const PENDING_VERIFIER_SESSIONS = new Set<string>();

/** Current on-disk signature for one deliverable, or null when it is gone /
 *  unreadable (a vanished file is not currently verifiable — dropped from the
 *  set rather than guessed at). */
function artifactSignature(path: string): string | null {
	try {
		const s = statSync(path);
		return `${s.mtimeMs}:${s.size}`;
	} catch {
		return null;
	}
}

export interface VerificationSubmitInput {
	parentOp: Op;
	sessionId: string;
	/** ONLY the new/changed deliverables — the brief's scope. */
	deliverables: string[];
}

type VerificationSubmitter = (input: VerificationSubmitInput) => Promise<boolean>;

/** Test seam: replaces the lazy import of verification-submit.ts so trigger
 *  conditions are testable without provider/runtime resolution. */
let submitterOverride: VerificationSubmitter | null = null;

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

		// ONE LIVE VERIFIER PER SESSION, part 1 — the O(1) half: a burst of
		// terminals while a submission is in flight collapses to nothing; the
		// next terminal after it settles picks up the accumulated delta.
		if (PENDING_VERIFIER_SESSIONS.has(sessionId)) {
			logger.debug(`[verify] skip ${op.id}: verification submission already in flight for ${sessionId}`);
			return;
		}

		// ARTIFACT-SET FINGERPRINT: fire only for new/changed deliverables.
		// THE per-turn exit for a chat session — a conversational turn that
		// wrote nothing stops here, before any per-peer op read.
		const current = new Map<string, string>();
		for (const path of deliverables) {
			const sig = artifactSignature(path);
			if (sig !== null) current.set(path, sig);
		}
		if (current.size === 0) {
			logger.debug(`[verify] skip ${op.id}: no deliverable currently readable on disk`);
			return;
		}
		const lastVerified = VERIFIED_ARTIFACTS.get(sessionId);
		const delta = [...current.keys()].filter((path) => lastVerified?.get(path) !== current.get(path));
		if (delta.length === 0) {
			logger.debug(`[verify] skip ${op.id}: deliverable set unchanged since last verification`);
			return;
		}

		// ONE LIVE VERIFIER PER SESSION, part 2 — the DISK half, reached only
		// on a real delta. A tracked running/pending verifier blocks the submit
		// WITHOUT recording the fingerprint, so this delta survives to the next
		// terminal.
		const liveVerifier = listOpsForSession(sessionId).some((id) => {
			if (id === event.opId) return false; // the terminating parent itself
			const peer = readOp(id);
			return !!peer
				&& peer.type === VERIFICATION_OP_TYPE
				&& (peer.status === "running" || peer.status === "pending");
		});
		if (liveVerifier) {
			logger.debug(`[verify] skip ${op.id}: a verification op is already live for ${sessionId}`);
			return;
		}

		// Fire. Record the full current map SYNCHRONOUSLY (closes the
		// double-projected-terminal window) and flag the in-flight submission.
		VERIFIED_ARTIFACTS.set(sessionId, current);
		PENDING_VERIFIER_SESSIONS.add(sessionId);
		const submit: VerificationSubmitter = submitterOverride
			?? (async (input) => (await import("./verification-submit.js")).submitVerificationOp(input));
		void submit({ parentOp: op, sessionId, deliverables: delta })
			.catch((e) => {
				if (!warnedOnce) {
					warnedOnce = true;
					logger.warn(`[verify] submission failed (further suppressed): ${(e as Error).message}`);
				}
			})
			.finally(() => PENDING_VERIFIER_SESSIONS.delete(sessionId));
	} catch (e) {
		if (!warnedOnce) {
			warnedOnce = true;
			logger.warn(`[verify] event hook failed (further suppressed): ${(e as Error).message}`);
		}
	}
}

/** Test-only: swap the submitter (null restores the lazy-import path). */
export function _setVerificationSubmitterForTests(fn: VerificationSubmitter | null): void {
	submitterOverride = fn;
}

/** Test-only: reset the warn-once latch, fingerprints, and in-flight flags. */
export function _resetVerificationTriggerForTests(): void {
	warnedOnce = false;
	VERIFIED_ARTIFACTS.clear();
	PENDING_VERIFIER_SESSIONS.clear();
}
