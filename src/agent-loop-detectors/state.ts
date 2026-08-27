// Shared types for detectors + the image-detection helper.

export type DetectorKind =
  | "planning-only"
  | "single-action-stop"
  | "reasoning-only"
  | "empty-response"
  | "uncommitted-turn"
  | "evidence-stale"
  | "incomplete-multistep";

export interface RetryInstruction {
  kind: DetectorKind;
  instruction: string;
}

export interface TurnState {
  /** Assistant's final visible text this attempt. */
  assistantText: string;
  /** Tool calls the model emitted this attempt. */
  toolCallsThisIteration: Array<{ name: string; arguments?: string }>;
  /** Every tool name called across the full turn (not just this iteration). */
  toolsCalledThisTurn: Set<string>;
  /** True if the model produced any reasoning tokens this attempt. */
  hasReasoning: boolean;
  /** Total completion tokens this attempt (provider-reported). */
  completionTokens: number;
  /** Number of iterations the turn has already run. */
  iteration: number;
  /** Evidence counter (filesRead + searches + tool results + edits). */
  evidenceCount: number;
  /** Evidence count at the start of each iteration — used for staleness. */
  evidenceHistory: number[];
  /**
   * True if the latest user message included an image attachment. When set,
   * the orchestrator skips planning-only / uncommitted-turn / evidence-stale
   * detectors — those misfire on vision replies. The agent's "this is what
   * I see in the picture" is a complete answer, not a stalled plan, but it
   * looks like one to the regex-based detectors and triggers a retry storm
   * (3+ near-identical reply restatements per turn).
   */
  userMessageHasImages?: boolean;
  /**
   * Highest step number the user's instruction enumerated (e.g. "1) … 2) … 3)"
   * → 3). 0 when the request isn't an enumerated multi-step task. Used by
   * detectIncompleteMultiStep to notice a model that completed step N and
   * yielded while N < this. Models like Claude finish all steps in one turn,
   * so their final reply names the last step and the detector stays silent;
   * models that yield after each committing step get nudged onward.
   */
  enumeratedSteps?: number;
  /**
   * True when the op has landed at least one SUBSTANTIVE committing call:
   * the per-call arg-aware verdict (so a `pdf create` counts and a `pdf read`
   * does not) with the model's own `task_*` ledger excluded. The caller
   * already computes it once per op
   * (CanonicalLoopContext.substantiveCommittingToolsThisOp, built in the same
   * op_turns walk that builds toolsCalledThisTurn's source) and passes it
   * through.
   *
   * Read by detectPlanningOnly and by nothing else. Its question — "did the
   * model do real work on the USER'S task, or only talk about it?" — is the
   * one this projection encodes. The other two commit-aware detectors read
   * `committedWorkOrLedger` below, which asks a broader question; the call
   * sites in detectors.ts carry the argument for why the two must stay split.
   *
   * Detectors must NOT re-derive this by scanning `toolsCalledThisTurn` with
   * isCommittingTool: that name-only view answers false for every arg-aware
   * tool (pdf / browser / http_request) and true for a pure planning turn,
   * which is the pair of bugs this field exists to close.
   *
   * NOISY INPUT — the arg-aware verdict is not clean. `browser` is credited
   * from a keyword regex whose target for an `act` call is a free-form
   * natural-language instruction, and a census of 3,681 real browser calls in
   * ~/.lax found 7 of the 9 matching shapes (13 of 17 calls) were false
   * positives. Both this field and `committedWorkOrLedger` carry it, so THREE
   * detectors are exposed, not two — planning-only here, uncommitted-turn and
   * evidence-stale below. Every consumer uses it to STAND DOWN, so the noise
   * costs a suppressed nudge and never a spurious one. Full measurement, the
   * `http_request` `{_raw: …}` variant of the same problem, and why the
   * worker-lane scope note is a sampling artifact rather than an exemption:
   * the detectUncommittedTurn call site in detectors.ts.
   *
   * REQUIRED, unlike the two optionals above — and it is the reason those two
   * are not precedent for making this one optional. Their miss-default is
   * benign: a missing `userMessageHasImages` only forgoes an exemption, a
   * missing `enumeratedSteps` only forgoes a nudge. This one's miss-default is
   * the opposite — absent reads as falsy, falsy means "no work on record", and
   * that FIRES a nudge. Requiring it turns a producer that forgets to compute
   * it from a silent behavior change into a compile error.
   */
  committedSubstantiveWork: boolean;
  /**
   * True when the op has landed at least one committing call of EITHER kind —
   * the UNION of the two op-level tallies the caller holds:
   * `CanonicalLoopContext.committingToolsThisOp.size > 0` (name-only
   * `isCommittingTool`, `task_*` ledger INCLUDED, every arg-aware tool
   * invisible) OR `substantiveCommittingToolsThisOp.size > 0` (the field
   * above). Both come from the same op_turns walk; neither is a subset of the
   * other, which is why this is a union and not a pick.
   *
   * Read by detectUncommittedTurn and detectEvidenceStale, whose question is
   * the broader "is there ANY committed side effect on record for this op?".
   * Neither half answers it alone. The substantive half misses the `task_*`
   * ledger, and both detectors judge agent/background ops that open-steps
   * seeds with a `task_create` plan on turn 0, so a read-only research op is
   * 0 there by definition and would be told to commit a change the user never
   * asked for. The name-only half misses `pdf` / `browser` / `http_request`,
   * so an op whose entire work was a `pdf create` or a `browser` submit read
   * as uncommitted and got nagged to commit work it had already committed.
   * The full argument, including the honest note that the read-only
   * stand-down is ACCIDENTAL, is at the detectUncommittedTurn call site — as
   * is the measured NOISE the arg-aware half brings with it (see the field
   * above; it reaches this union too).
   *
   * The producer computes this union INLINE from its two ctx tallies rather
   * than calling opCommittedWork, which it is exactly equivalent to for every
   * row dispatch can write. That equivalence is pinned by
   * canonical-loop/middlewares/committed-work-union-contract.test.ts — if it
   * ever goes red, this field has stopped meaning "did this op commit
   * anything?" and both readers below are judging something else.
   *
   * REQUIRED for the same reason as the field above: falsy means "nothing on
   * record", which fires a nudge.
   */
  committedWorkOrLedger: boolean;
}

/**
 * True if any user message in the array carries an image_url part. Callers
 * pass this through to TurnState.userMessageHasImages.
 */
export function userMessageHasImages(messages: Array<{ role: string; content: unknown }>): boolean {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.role !== "user") continue;
    if (Array.isArray(m.content)) {
      for (const part of m.content as Array<{ type?: string }>) {
        if (part?.type === "image_url" || part?.type === "image") return true;
      }
    }
    return false; // most recent user message decides — older ones don't matter
  }
  return false;
}
