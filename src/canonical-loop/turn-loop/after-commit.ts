/**
 * What runs once a turn is durable — the effects that must wait for
 * commitTurn, in the order driveTurn has always run them:
 *   1. the skill review (record-outcome.ts requestSkillReviewForOp), which
 *      renders the op's own committed transcript;
 *   2. the per-turn app snapshot (snapshot-apps.ts), fire-and-forget;
 *   3. the guard fires decideTurnOutcome earned (guard-fire.ts bankEarnedFires);
 *   4. the sticky directive's nudge, abort bubble or suspend record
 *      (apply-directive.ts).
 *
 * Owns only the sequence and the reason each step waits. A cancel bails before
 * commitTurn, and a commit that throws never reaches here, so none of these
 * describes a turn that was not written.
 *
 * Does not own: any of the four effects (each module above does), the commit
 * itself (checkpoint.ts), or what the worker does with the directive next.
 */
import type { Op } from "../../ops/types.js";
import type { ToolCall } from "../contract-types.js";
import type { ResolvedTurnLoopDeps } from "./turn-deps.js";
import type { MiddlewareDirective } from "./types.js";
import { bankEarnedFires, type GuardFire } from "./guard-fire.js";
import { applyCommittedDirective } from "./apply-directive.js";

export interface CommittedTurn {
  op: Op;
  turnIdx: number;
  /** Set only when the turn reached a terminal outcome (resolveLearningSessionId). */
  learningSessionId: string | null;
  toolCalls: ToolCall[];
  earnedFires: readonly GuardFire[];
  directive: MiddlewareDirective | null;
}

type AfterCommitDeps = Pick<ResolvedTurnLoopDeps,
  | "requestSkillReviewForOp" | "snapshotTouchedApps"
  | "appendNudgeAsUserMessage" | "recoverCommittedStrategyPivot" | "emitErrorOnce">;

export function runAfterCommit(turn: CommittedTurn, deps: AfterCommitDeps): void {
  const { op, turnIdx, directive } = turn;
  // Post-commit ONLY — see record-outcome.ts.
  if (turn.learningSessionId) deps.requestSkillReviewForOp(op, turn.learningSessionId, turnIdx);

  // Tier 1.C: per-turn snapshot of any app files this turn wrote/edited.
  // Powers the IDE topbar's ↺ Revert dropdown so the user can undo a bad
  // edit without asking the agent to fix what it just broke.
  void deps.snapshotTouchedApps(turn.toolCalls, turnIdx);

  // Fires earned inside decideTurnOutcome. Banked HERE because the message each
  // describes lived only in `allMessages` until commitTurn, with the cancel
  // bail in between — same ordering contract as the directive records below.
  bankEarnedFires(op.id, turnIdx, turn.earnedFires);

  // Nudge materialization, the abort bubble and the abort/suspend fire records
  // all wait for the durable turn — see apply-directive.ts for that ordering
  // contract. A cancel bails before commit, so a discarded directive is never applied.
  if (directive) {
    applyCommittedDirective(op, turnIdx, directive, {
      appendNudgeAsUserMessage: deps.appendNudgeAsUserMessage,
      recoverCommittedStrategyPivot: deps.recoverCommittedStrategyPivot,
      emitErrorOnce: deps.emitErrorOnce,
    });
  }
}
