import { describe, it, expect } from "vitest";
import {
  CLAIM_GROUNDING_RULES,
  claimGroundingRule,
  evaluateClaimGrounding,
  type ClaimKind,
  type EvidenceKind,
} from "./claim-grounding.js";

describe("claim grounding rules", () => {
  it("grounds a source done-claim only on a real build/type-check/test run", () => {
    const ungrounded = evaluateClaimGrounding("source-done", []);
    expect(ungrounded.grounded).toBe(false);
    expect(ungrounded.consequence).toBe("partial-label");
    expect(ungrounded.missingEvidence).toEqual(["build-clean"]);
    expect(ungrounded.message).toContain("clean build");

    expect(evaluateClaimGrounding("source-done", ["build-clean"])).toMatchObject({
      grounded: true,
      missingEvidence: [],
      consequence: null,
      reason: null,
      message: null,
      statusText: null,
    });
  });

  // The repo-advice, cleanup-done and runtime-causality rules went out with the
  // guards that evaluated them — each judged the model's WORDING and then
  // retracted or rewrote its answer. Pin their absence so a rule cannot come
  // back without a consumer.
  it("declares only the rule a live consumer dispatches", () => {
    expect(CLAIM_GROUNDING_RULES.map(r => String(r.claimKind))).toEqual(["source-done"]);
  });

  it("fails closed for a missing claim kind", () => {
    expect(() => claimGroundingRule("unknown" as ClaimKind)).toThrow("No claim-grounding rule");
  });

  // "lsp-clean" exists as a kind (compile-time check below) but is deliberately
  // WEAK positive evidence — no rule accepts it, so it can never ground a claim
  // on its own. It only softens the verify-gate nudge's tone.
  it('keeps "lsp-clean" an EvidenceKind that NO rule accepts', () => {
    const kind: EvidenceKind = "lsp-clean"; // compiles ⇔ the union member exists
    for (const rule of CLAIM_GROUNDING_RULES) {
      expect(rule.requiredAny, `rule ${rule.claimKind} must not accept lsp-clean`).not.toContain(kind);
    }
    expect(evaluateClaimGrounding("source-done", ["lsp-clean"]).grounded).toBe(false);
  });
});
