import { describe, it, expect } from "vitest";
import {
  CLAIM_GROUNDING_RULES,
  CODEBASE_ADVICE_GROUNDING_REASON,
  CODEBASE_ADVICE_GROUNDING_STATUS,
  claimGroundingRule,
  evaluateClaimGrounding,
  type ClaimKind,
  type EvidenceKind,
} from "./claim-grounding.js";

describe("claim grounding rules", () => {
  it("grounds repo implementation advice only after fresh code evidence", () => {
    const ungrounded = evaluateClaimGrounding("repo-advice", []);
    expect(ungrounded.grounded).toBe(false);
    expect(ungrounded.reason).toBe(CODEBASE_ADVICE_GROUNDING_REASON);
    expect(ungrounded.consequence).toBe("replace-status");
    expect(ungrounded.statusText).toBe(CODEBASE_ADVICE_GROUNDING_STATUS);
    expect(ungrounded.message).toContain("without fresh code evidence");

    const grounded = evaluateClaimGrounding("repo-advice", ["code-read"]);
    expect(grounded).toMatchObject({
      grounded: true,
      missingEvidence: [],
      consequence: null,
      reason: null,
      message: null,
      statusText: null,
    });
  });

  it("lets cleanup done-claims be grounded by either a clean search or accounted remaining hits", () => {
    expect(evaluateClaimGrounding("cleanup-done", []).grounded).toBe(false);
    expect(evaluateClaimGrounding("cleanup-done", ["search-clean"]).grounded).toBe(true);
    expect(evaluateClaimGrounding("cleanup-done", ["remaining-hits-accounted"]).grounded).toBe(true);
  });

  it("keeps the other claim classes explicit in the same table", () => {
    expect(evaluateClaimGrounding("source-done", []).missingEvidence).toEqual(["build-clean"]);
    expect(evaluateClaimGrounding("runtime-causality", []).consequence).toBe("retract");
    expect(evaluateClaimGrounding("ui-done", ["browser-render"]).grounded).toBe(true);
  });

  it("fails closed for a missing claim kind", () => {
    expect(() => claimGroundingRule("unknown" as ClaimKind)).toThrow("No claim-grounding rule");
  });

  // Regression pin for the "lsp-clean" widening: the kind exists (compile-time
  // check below) but is deliberately WEAK positive evidence — NO rule accepts
  // it, so it can never ground a claim on its own. In particular the
  // claim-integrity consumers must be behaviorally unchanged: operational-claim
  // (runtime-causality), codebase-advice (repo-advice), and cleanup-verify
  // (cleanup-done) do not accept it, and neither does source-done — the
  // build/test run ("build-clean") stays the grounding evidence.
  it('adds "lsp-clean" as an EvidenceKind that NO rule accepts', () => {
    const kind: EvidenceKind = "lsp-clean"; // compiles ⇔ the union member exists
    for (const rule of CLAIM_GROUNDING_RULES) {
      expect(rule.requiredAny, `rule ${rule.claimKind} must not accept lsp-clean`).not.toContain(kind);
    }
    expect(evaluateClaimGrounding("source-done", ["lsp-clean"]).grounded).toBe(false);
    expect(evaluateClaimGrounding("runtime-causality", ["lsp-clean"]).grounded).toBe(false);
    expect(evaluateClaimGrounding("repo-advice", ["lsp-clean"]).grounded).toBe(false);
    expect(evaluateClaimGrounding("cleanup-done", ["lsp-clean"]).grounded).toBe(false);
    expect(evaluateClaimGrounding("ui-done", ["lsp-clean"]).grounded).toBe(false);
  });
});
