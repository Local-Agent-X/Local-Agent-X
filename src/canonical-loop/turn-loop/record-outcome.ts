/**
 * Terminal-outcome recording for one op (PRD §15 completion ledger).
 *
 * Split out of decide-outcome.ts so both the normal turn-loop path and the
 * MAX_TURNS truncation path in worker.ts can record an op's outcome under its
 * tool-derived category without either file forking the categorization logic.
 *
 * Also owns the post-turn skill-review trigger (campaign D13): "the op ended, I
 * have the full tool sequence, should we learn a procedure from it?" is the
 * same question this file already answers for durable memory, so it lives here
 * rather than in a second seam. See the trigger section at the bottom.
 */
import type { Op } from "../../ops/types.js";
import { readOpTurns } from "../store.js";
import { resolveOpModel } from "../op-model.js";
import {
  classifyOpCategory,
  normalizeObservedToolName,
  recordOpOutcome,
  type OpOutcome,
} from "../../tool-tracker.js";
import { getSessionForOp } from "../../ops/session-bridge.js";
import { isInteractiveHostOpType } from "../../ops/op-store.js";
import crossSessionLearner from "../../cognition/cross-session-learning/index.js";
import { hasExternalIngestion, isExternalIngestingTool } from "../../data-lineage/external.js";
import { getTaintSummary } from "../../data-lineage/taint.js";
import { renderOpTranscript } from "./op-transcript.js";
import { boostNudgePriority } from "../../memory/curate-nudge.js";
import { createLogger } from "../../logger.js";

const logger = createLogger("canonical-loop.turn-loop.record-outcome");

export type { OpOutcome };

/**
 * Record the op's terminal outcome under its tool-derived category. The category
 * spans every tool the op touched across all committed turns (plus any extras
 * observed this turn), so an op that ends tool-lessly still classifies right.
 * Shared with the MAX_TURNS truncation path in worker.ts: a force-terminated op
 * transitions straight to failed, skipping the turn-loop, so without recording
 * here it would escape the outcome ledger entirely (the completion metric went
 * blind to every truncated run).
 */
export function recordTerminalOutcome(
  op: Op,
  outcome: OpOutcome,
  extraToolNames: Iterable<string> = [],
): void {
  const toolSequence = collectToolSequence(op.id, extraToolNames);
  const category = classifyOpCategory(new Set(toolSequence));
  recordOpOutcome(category, outcome, resolveOpModel(op));
}

function collectToolSequence(opId: string, extraToolNames: Iterable<string> = []): string[] {
  const toolSequence: string[] = [];
  for (const turn of readOpTurns(opId)) {
    for (const s of turn.toolCallSummary ?? []) toolSequence.push(s.tool);
    for (const t of turn.observedTools ?? []) toolSequence.push(t);
  }
  for (const t of extraToolNames) toolSequence.push(t);
  return toolSequence;
}

export function isLearningOutcomeEligible(
  op: Op,
  sessionId: string,
  toolSequence = collectToolSequence(op.id),
): boolean {
  if (!sessionId || hasExternalIngestion(sessionId) || getTaintSummary(sessionId).count > 0) return false;
  return !toolSequence.some((tool) => {
    const normalized = normalizeObservedToolName(tool);
    const externalMcpServer = tool.startsWith("mcp__") && !tool.startsWith("mcp__lax__");
    return externalMcpServer || isExternalIngestingTool(normalized);
  });
}

/** Persist learning evidence only after commitTurn succeeds. Unlike aggregate
 *  telemetry, learned evidence must never observe a provisional terminal state:
 *  cancellation and commit failure can still invalidate it. */
export function recordCommittedLearningOutcome(
  op: Op,
  outcome: OpOutcome,
  sessionId: string,
  timestamp = Date.now(),
): void {
  const toolSequence = collectToolSequence(op.id);
  if (!isLearningOutcomeEligible(op, sessionId, toolSequence)) return;
  const category = classifyOpCategory(new Set(toolSequence));
  const model = resolveOpModel(op);
  crossSessionLearner.recordOutcome({
    opId: op.id,
    sessionId,
    outcome,
    category,
    tools: toolSequence,
    model,
    timestamp,
  });
}

// ── Skill-review trigger (campaign D13 / D14 / D15) ───────────────────────

/**
 * Queue a post-turn skill review for an op that just terminated.
 *
 * MUST be called AFTER commitTurn. Every pre-commit call site — the cancel-aware
 * bail in turn-loop.ts, worker.ts's abort paths, a commitTurn that threw — would
 * hand the fork a conversation missing its entire final turn, and in the worst
 * case (a terminal turn 0) a transcript with zero steps alongside a tool
 * sequence claiming a multi-step workflow. The fork would then author a playbook
 * out of nothing.
 *
 * Ordering is not trusted, though: `durableTerminalTurn` re-derives the same
 * fact from disk, so a future caller that moves this earlier fails closed
 * instead of silently authoring from a truncated transcript. A user who pressed
 * Stop has not consented to anything being learned from that op.
 *
 * Deferred to the next check-phase tick purely for COST: the render re-reads
 * every turn artifact and the turn loop is the hottest path in the app.
 * Foreground cost of calling this is one type check plus one setImmediate.
 */
export function requestSkillReviewForOp(op: Op, sessionId: string, turnIdx: number): void {
  if (!sessionId) return;
  // R2: reviews are for USER-FACING conversations only. Delegated, cron, dream,
  // self-edit and build workers all inherit the parent chat session id
  // (ops/tools/shared.ts delegatedRuntimeSessionId), and chunk D's queue
  // coalesces per SESSION — so an unfiltered trigger lets a background worker's
  // machine transcript overwrite the user's real conversation under the same
  // key, and stamps the resulting protocol with provenance pointing at a
  // conversation that produced neither. It would also buy a MAIN-model review
  // of every cron tick. `isInteractiveHostOpType` is the canonical predicate for
  // "the op executing the user's turn" (op-store.ts); `parentOpId` rejects a
  // spawned op that named itself chat_turn.
  if (!isInteractiveHostOpType(op.type) || op.parentOpId) return;
  const opId = op.id;
  setImmediate(() => { void runSkillReviewTrigger(opId, sessionId, turnIdx); });
}

/**
 * Did THIS turn's commit land, terminally?
 *
 * Scoped to the committing turn on purpose. An op-wide "some terminal row
 * exists" check would be satisfied by any earlier terminal row, which makes the
 * property accidental rather than checked.
 *
 * What it actually guarantees — the reason the transcript is safe to render —
 * is that turn rows and messages are the SAME artifact: publishTurnCommit
 * writes one TurnCommitEnvelope holding `{turn, messages}` via
 * stage→fsync→rename, and readOpMessages reconstructs from those same
 * artifacts. A terminal row therefore cannot exist without its messages. No row
 * for this turn → the commit did not happen (cancelled, fenced, threw) → the
 * transcript would be missing its final turn → refuse.
 *
 * "cancelled" is excluded alongside a missing row: a user who pressed Stop has
 * not consented to anything being learned from that op.
 */
function durableTerminalTurn(opId: string, turnIdx: number): boolean {
  return readOpTurns(opId).some((t) =>
    t.turnIdx === turnIdx && (t.terminalReason === "done" || t.terminalReason === "error"));
}

async function runSkillReviewTrigger(opId: string, sessionId: string, turnIdx: number): Promise<void> {
  try {
    // Dynamic import (grep note: this is the only edge from the turn loop into
    // the skill-review job). skill-review.ts imports canonical-loop/index.js, so
    // a static import here would close an ESM cycle through the turn loop's own
    // terminal path — a module-init hazard on the hottest path in the app.
    const { requestSkillReview, isReviewWorthy } =
      await import("../../server/background-jobs/skill-review.js");
    if (!durableTerminalTurn(opId, turnIdx)) {
      logger.debug(`[skill-review] ${opId}#${turnIdx} did not commit terminally — not reviewing`);
      return;
    }
    // Post-commit the store holds the whole op, so the canonical helper needs no
    // extras. Same function recordCommittedLearningOutcome uses (D13) — but
    // deliberately WITHOUT isLearningOutcomeEligible (D14): that gate refuses any
    // session with external ingestion, i.e. every browser session, and the
    // workflow this feature exists to capture IS a browser workflow. It guards
    // durable MEMORY promotion, a different axis. Authoring is autonomous
    // including from browser sessions (D1); the residual injected-content risk
    // is recorded and accepted in the campaign ledger.
    const toolSequence = collectToolSequence(opId);
    if (!isReviewWorthy(toolSequence)) return;

    // F5 / D15: `long-task-completed` is documented "tool-heavy turn just
    // finished" and had no production caller — the only boost sites are regex /
    // classifier checks on the USER MESSAGE, so a tool-heavy turn advanced
    // nothing. This is the signal it was built for.
    //
    // SPEND, stated plainly: end-of-turn-write.ts:110 resets curate-nudge state
    // on every run, clearing pendingTriggers, so the next tool-heavy turn
    // re-boosts. The memory extraction classifier therefore becomes eligible on
    // essentially every user message doing >=4 calls / >=2 distinct tools, where
    // before it needed a regex or classifier hit on the user's own text —
    // roughly +5-8 classifier calls per 10 tool-heavy messages, on top of one
    // main-model review fork per such message. Fired BEFORE rendering so a
    // transcript failure cannot also cost the memory pass its nudge.
    boostNudgePriority(sessionId, "long-task-completed");

    const result = requestSkillReview({ sessionId, toolSequence, transcript: renderOpTranscript(opId) });
    if (!result.queued) logger.debug(`[skill-review] not queued for ${opId}: ${result.reason}`);
  } catch (e) {
    // Non-fatal by construction. This already runs off the turn's critical
    // path, but a throw here is an unhandled rejection inside a setImmediate
    // callback — fatal to the process under Node's default policy, i.e. the
    // server dies mid-conversation. Logged loudly: never hidden, never
    // surfaced into the user's turn.
    logger.warn(`[skill-review] trigger failed for op ${opId}: ${(e as Error).message}`);
  }
}

/** Capture before terminal commit releases the live session binding. */
export function resolveLearningSessionId(op: Op): string {
  // An op id is unique work identity, not conversation provenance. Keep the
  // session unknown when no live binding exists so later distinct-session
  // confidence cannot count detached ops as separate conversations.
  return getSessionForOp(op.id) ?? "";
}
