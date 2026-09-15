/** One claim kind today. The repo-advice, cleanup-done and runtime-causality
 *  rules went out with the guards that judged the model's wording; this one
 *  survives because its evidence is a real build/test exit code. */
export type ClaimKind = "source-done";

export type EvidenceKind =
  | "code-read"
  | "search-clean"
  | "remaining-hits-accounted"
  | "build-clean"
  | "diagnostic-read"
  | "browser-render"
  /** Post-edit language-service diagnostics are clean on EVERY edited TS/JS
   *  file (post-edit-diagnostics' per-op state). Deliberate weighting: WEAK
   *  positive evidence — type-clean is not run-clean, so this is never
   *  sufficient alone to ground a source-done claim. No rule's `requiredAny`
   *  lists it (pinned by claim-grounding.test.ts); the build/test run
   *  ("build-clean") remains the grounding evidence. Its only effect is to
   *  soften the verify-gate nudge tone (agent-guards/verify-gate.ts). */
  | "lsp-clean";

export type GroundingConsequence = "nudge" | "partial-label";

export interface ClaimGroundingRule {
  claimKind: ClaimKind;
  requiredAny: EvidenceKind[];
  consequence: GroundingConsequence;
  reason: string;
  missingEvidenceMessage: string;
  statusText?: string;
}

export interface GroundingVerdict {
  claimKind: ClaimKind;
  grounded: boolean;
  missingEvidence: EvidenceKind[];
  consequence: GroundingConsequence | null;
  reason: string | null;
  message: string | null;
  statusText: string | null;
}

// The reason string is the wire contract between the guard's middleware (which
// emits `{ kind: "nudge", reason }`) and the terminal label in
// turn-loop/terminal-epilogue.ts. It lives HERE, on the canonical table, so the
// rule's declared `consequence` and the reason that triggers it are
// single-sourced.
/** source-done → nudge / partial-label (never retract). */
export const SOURCE_VERIFY_REASON = "verify-gate";
export const CLAIM_GROUNDING_RULES: ClaimGroundingRule[] = [
  {
    claimKind: "source-done",
    requiredAny: ["build-clean"],
    consequence: "partial-label",
    reason: SOURCE_VERIFY_REASON,
    missingEvidenceMessage:
      "A source-change done-claim needs a clean build, type-check, or relevant test run.",
  },
  // DELETED: a "ui-done" rule (requiredAny ["browser-render"], consequence
  // "partial-label", reason "render-verify"). It was declared but dead on all
  // three legs — evaluateClaimGrounding was never called with "ui-done" outside
  // its own unit test, nothing in production read the reason constant, and
  // terminal-epilogue.ts had no render predicate, so the declared partial-label
  // could never fire. Removed rather than wired: adding an `opRenderUnverified`
  // predicate would DEMOTE a render-verify failure to a `partial` terminal
  // label, which is new user-visible behavior, not a table correction.
  //
  // Render verification is live today as a completion GATE
  // (COMPLETION_GATES "render-verify" in turn-loop/decide-outcome-gates.ts — a
  // different namespace that happens to share the string): it retries and
  // nudges, and never touches the outcome label. Whether an unrecovered
  // render-verify failure SHOULD demote the label to partial is an open product
  // decision, deliberately not taken here. Wiring it means re-adding the rule
  // AND a ledger predicate in terminal-epilogue.ts — the pair is enforced by
  // turn-loop/claim-grounding-dispatch.test.ts, so a rule can't come back alone.
  //
  // "browser-render" is left in EvidenceKind but is now referenced by no rule.
];

export function claimGroundingRule(claimKind: ClaimKind): ClaimGroundingRule {
  const rule = CLAIM_GROUNDING_RULES.find(r => r.claimKind === claimKind);
  if (!rule) throw new Error(`No claim-grounding rule for ${claimKind}`);
  return rule;
}

export function evaluateClaimGrounding(
  claimKind: ClaimKind,
  evidence: Iterable<EvidenceKind>,
): GroundingVerdict {
  const rule = claimGroundingRule(claimKind);
  const seen = new Set(evidence);
  const grounded = rule.requiredAny.some(e => seen.has(e));
  return {
    claimKind,
    grounded,
    missingEvidence: grounded ? [] : [...rule.requiredAny],
    consequence: grounded ? null : rule.consequence,
    reason: grounded ? null : rule.reason,
    message: grounded ? null : rule.missingEvidenceMessage,
    statusText: grounded ? null : rule.statusText ?? null,
  };
}
