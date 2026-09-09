export type ClaimKind =
  | "repo-advice"
  | "cleanup-done"
  | "source-done"
  | "runtime-causality";

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

export type GroundingConsequence =
  | "nudge"
  | "retract"
  | "replace-status"
  | "partial-label";

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

// Reason strings are the wire contract between a guard's middleware (which emits
// `{ kind: "nudge", reason }`) and the consequence dispatch in
// turn-loop/decide-outcome.ts (which keys retract / replace-status off the
// reason). They live HERE, on the canonical table, so a rule's declared
// `consequence` and the reason that actually triggers it are single-sourced —
// not three raw copies (table, middleware, RETRACTABLE_REASONS) free to drift.
// claim-grounding-dispatch.test.ts pins consequence ↔ dispatch so a mismatch
// fails the build instead of silently making the table lie.
export const CODEBASE_ADVICE_GROUNDING_REASON = "codebase-advice-grounding";
/** runtime-causality → retract. A definitive runtime/policy/causality claim made
 *  with no fresh diagnostic evidence; the false bubble is retracted. */
export const OPERATIONAL_CLAIM_REASON = "unsupported-operational-claim";
/** cleanup-done base reason → nudge only (an honest "still remain" wrap-up). */
export const CLEANUP_VERIFY_REASON = "cleanup-verify";
/** cleanup-done escalation → retract. A positive "cleanup complete" done-claim
 *  with no confirming empty search; the confirmed-false bubble is retracted.
 *  Not a `rule.reason` (it's a sub-state escalation of cleanup-done), but owned
 *  here so every retract-driving claim-grounding reason lives in one module. */
export const CLEANUP_VERIFY_FALSE_DONE_REASON = "cleanup-verify-false-done";
/** source-done → nudge / partial-label (never retract). */
export const SOURCE_VERIFY_REASON = "verify-gate";
export const CODEBASE_ADVICE_GROUNDING_STATUS =
  "Checking the current repo before I recommend a harness change...";

export const CLAIM_GROUNDING_RULES: ClaimGroundingRule[] = [
  {
    claimKind: "repo-advice",
    requiredAny: ["code-read"],
    consequence: "replace-status",
    reason: CODEBASE_ADVICE_GROUNDING_REASON,
    statusText: CODEBASE_ADVICE_GROUNDING_STATUS,
    missingEvidenceMessage:
      "You're giving codebase implementation direction without fresh code evidence in this op. " +
      "Do not rely on docs, memory, or prior assistant summaries as proof. Read or search the actual " +
      "repo files first, then give the recommendation grounded in the current code. If you cannot inspect " +
      "the code, retract the recommendation and say what remains unknown.",
  },
  {
    claimKind: "cleanup-done",
    requiredAny: ["search-clean", "remaining-hits-accounted"],
    consequence: "partial-label",
    reason: CLEANUP_VERIFY_REASON,
    missingEvidenceMessage:
      "A removal or cleanup done-claim needs a broad clean search, or an explicit accounting of every remaining hit.",
  },
  {
    claimKind: "source-done",
    requiredAny: ["build-clean"],
    consequence: "partial-label",
    reason: SOURCE_VERIFY_REASON,
    missingEvidenceMessage:
      "A source-change done-claim needs a clean build, type-check, or relevant test run.",
  },
  {
    claimKind: "runtime-causality",
    requiredAny: ["diagnostic-read"],
    consequence: "retract",
    reason: OPERATIONAL_CLAIM_REASON,
    missingEvidenceMessage:
      "You made a definitive claim about a system's runtime, policy, security decision, or causal history " +
      "without fresh diagnostic evidence in this op. Memory and prior assistant messages are leads, not evidence. " +
      "Inspect logs/state/code with an available read-only tool before asserting the claim. If verification is " +
      "unavailable, retract the claim and explicitly say what is unknown or only a hypothesis.",
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
