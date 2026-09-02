/**
 * Verification trigger — the keystone observer of the verification-invariants
 * campaign.
 *
 * Always-on observer on the canonical event seam (projectCanonicalEvent,
 * event-emitter.ts), wired beside cost-recording.ts and
 * trash-scope-observer.ts. When a NON-interactive op SUCCEEDS in a session
 * that (a) ingested external content (data-lineage/external.ts — untrusted
 * off-box figures flowed into this task) and (b) created persistent
 * deliverables (data-lineage/task-artifacts.ts, filtered to
 * DELIVERABLE_EXTENSIONS), it submits ONE background verification op whose
 * task is buildVerificationBrief — an independent model re-acquires the
 * deliverable's load-bearing values and reports a first-line VERDICT.
 *
 * The verification op is a NORMAL background op, deliberately NOT in
 * session-bridge-observer's SIDEBAR_SUPPRESSED_OP_TYPES: it shows in the
 * AGENTS panel nested under its parent (parentOpId carries the lineage), and
 * its completion rides the ordinary bg_op_completed → pending-notifications
 * channel so the agent narrates the verdict on the next turn.
 *
 * Guard order, cheapest discriminator first (the non-terminal-event path is
 * exactly ONE property check):
 *   1. event type: only `state_changed`, and only `to: "succeeded"`.
 *   2. op type: not an interactive host turn (chat_turn / voice_turn — a
 *      reply turn ending, not a task ending), and not VERIFICATION_OP_TYPE
 *      itself — the recursion guard. Belt for a broken marker: the submit
 *      stamps a hard OpBudget, so even runaway recursion is bounded per op.
 *   3. session facts: binding resolvable, external ingestion recorded, at
 *      least one deliverable-extension artifact.
 *   4. dedup: no live verification op for the same parentOpId (the
 *      op_submit_async live-peer guard shape) plus an in-process
 *      submitted-parents ledger that closes the async submission window
 *      against double-projected terminal events.
 *   5. the `verifyDeliverables` runtime setting — checked inside
 *      verification-submit.ts, which also keeps config.ts (import-time side
 *      effects) out of this module's load graph: event-emitter.ts imports
 *      this file at the core of the loop, so the heavy submission half is
 *      loaded lazily on the first candidate only.
 *
 * ORDER-SENSITIVE: wired BEFORE the session-bridge observer in
 * projectCanonicalEvent (same reason as trash-scope-observer): the bridge's
 * terminal branch releases the op↔session binding, after which
 * getSessionForOp / listOpsForSession come back empty.
 *
 * Pure instrumentation — never throws, never blocks the op terminal path
 * (cost-recording posture). Submission is fire-and-forget async.
 */
import { extname } from "node:path";
import { readOp, isInteractiveHostOpType } from "../ops/op-store.js";
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
 *  keys per-type icons on, and it must stay OUT of session-bridge-observer's
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

/** Parent op ids a verification submission has already been fired for. In
 *  paired duty with the live-peer scan below: the scan needs the verification
 *  op tracked in the session map, which only happens after the async submit
 *  lands — this ledger closes that window (double-projected terminal events
 *  arrive synchronously back-to-back). Terminal events never legitimately
 *  re-fire for an op, so entries are kept for the process's life
 *  (EMITTED_ERRORS posture, event-emitter.ts). */
const SUBMITTED_PARENTS = new Set<string>();

export interface VerificationSubmitInput {
	parentOp: Op;
	sessionId: string;
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
		if (isInteractiveHostOpType(op.type)) return; // a reply turn ending, not a task ending
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

		if (SUBMITTED_PARENTS.has(op.id)) {
			logger.debug(`[verify] skip ${op.id}: verification already submitted for this parent`);
			return;
		}
		// Live-peer dedup, mirroring op_submit_async's guard: a verification
		// op already running/pending for this parent blocks a second spawn.
		const livePeer = listOpsForSession(sessionId).some((id) => {
			if (id === event.opId) return false; // the terminating parent itself
			const peer = readOp(id);
			return !!peer
				&& peer.type === VERIFICATION_OP_TYPE
				&& (peer.status === "running" || peer.status === "pending")
				&& peer.parentOpId === op.id;
		});
		if (livePeer) {
			logger.debug(`[verify] skip ${op.id}: live verification peer already exists`);
			return;
		}
		SUBMITTED_PARENTS.add(op.id);

		// Fire-and-forget: the heavy half (provider resolution, sealed runtime,
		// canonicalLoopEntry) loads lazily and must never block or throw into
		// the terminal path. The setting gate (verifyDeliverables) lives there.
		const submit: VerificationSubmitter = submitterOverride
			?? (async (input) => (await import("./verification-submit.js")).submitVerificationOp(input));
		void submit({ parentOp: op, sessionId, deliverables }).catch((e) => {
			if (!warnedOnce) {
				warnedOnce = true;
				logger.warn(`[verify] submission failed (further suppressed): ${(e as Error).message}`);
			}
		});
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

/** Test-only: reset the warn-once latch and the submitted-parents ledger. */
export function _resetVerificationTriggerForTests(): void {
	warnedOnce = false;
	SUBMITTED_PARENTS.clear();
}
