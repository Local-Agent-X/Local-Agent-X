export type ClaimKind =
  | "repo-advice"
  | "cleanup-done"
  | "source-done"
  | "runtime-causality"
  | "ui-done";

export type EvidenceKind =
  | "code-read"
  | "search-clean"
  | "remaining-hits-accounted"
  | "build-clean"
  | "diagnostic-read"
  | "browser-render";

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
/** ui-done → nudge / partial-label (never retract). */
export const RENDER_VERIFY_REASON = "render-verify";
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
  {
    claimKind: "ui-done",
    requiredAny: ["browser-render"],
    consequence: "partial-label",
    reason: RENDER_VERIFY_REASON,
    missingEvidenceMessage:
      "A UI done-claim needs browser, screenshot, or render verification evidence.",
  },
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
