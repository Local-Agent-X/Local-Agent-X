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

export const CODEBASE_ADVICE_GROUNDING_REASON = "codebase-advice-grounding";
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
    reason: "cleanup-verify",
    missingEvidenceMessage:
      "A removal or cleanup done-claim needs a broad clean search, or an explicit accounting of every remaining hit.",
  },
  {
    claimKind: "source-done",
    requiredAny: ["build-clean"],
    consequence: "partial-label",
    reason: "verify-gate",
    missingEvidenceMessage:
      "A source-change done-claim needs a clean build, type-check, or relevant test run.",
  },
  {
    claimKind: "runtime-causality",
    requiredAny: ["diagnostic-read"],
    consequence: "retract",
    reason: "unsupported-operational-claim",
    missingEvidenceMessage:
      "A runtime, policy, security, or causality claim needs fresh diagnostic evidence.",
  },
  {
    claimKind: "ui-done",
    requiredAny: ["browser-render"],
    consequence: "partial-label",
    reason: "render-verify",
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
