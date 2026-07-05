import { describe, it, expect } from "vitest";
import {
  CLAIM_GROUNDING_RULES,
  CODEBASE_ADVICE_GROUNDING_REASON,
  CLEANUP_VERIFY_REASON,
  CLEANUP_VERIFY_FALSE_DONE_REASON,
} from "../../agent-guards/index.js";
import { isRetractableHallucination } from "./retract-false-claim.js";

// Cross-seam contract. The canonical claim-grounding table (agent-guards) DECLARES
// a `consequence` per rule, but the runtime consequence is dispatched here in the
// turn loop off the guard's emitted `reason` string:
//   - "retract"        → isRetractableHallucination(reason) in retract-false-claim.ts
//   - "replace-status" → reason === CODEBASE_ADVICE_GROUNDING_REASON in decide-outcome.ts
// Those are two separately-maintained encodings of one policy. Nothing at runtime
// reads `rule.consequence`, so without this test the declared consequence and the
// real dispatch are free to drift — flip a consequence, rename a reason, or drop a
// reason from RETRACTABLE_REASONS and the table silently lies. These assertions
// make any such mismatch fail the build. See [silent-seam-regressions].

describe("claim-grounding consequence ↔ dispatch contract", () => {
  it("every rule's declared consequence matches what the dispatch actually does", () => {
    for (const rule of CLAIM_GROUNDING_RULES) {
      const retracts = isRetractableHallucination(rule.reason);
      // The ONLY consequence that retracts is "retract"; every other consequence
      // must leave its base reason non-retractable (a partial-label / replace-
      // status / nudge reason that snuck into RETRACTABLE_REASONS would silently
      // strip honest wrap-up text).
      expect(retracts, `rule ${rule.claimKind} (reason "${rule.reason}", consequence "${rule.consequence}")`)
        .toBe(rule.consequence === "retract");

      // replace-status is dispatched by an exact reason match in decide-outcome —
      // pin the string so a rename can't split the producer from the matcher.
      if (rule.consequence === "replace-status") {
        expect(rule.reason).toBe(CODEBASE_ADVICE_GROUNDING_REASON);
      }
    }
  });

  it("at least one rule exercises the retract consequence (guards against a vacuous pass)", () => {
    const retractRules = CLAIM_GROUNDING_RULES.filter(r => r.consequence === "retract");
    expect(retractRules.length).toBeGreaterThan(0);
    for (const rule of retractRules) {
      expect(isRetractableHallucination(rule.reason)).toBe(true);
    }
  });

  it("pins the cleanup-done escalation pair: false-done retracts, honest-partial does not", () => {
    // cleanup-done has a sub-state escalation the single `rule.consequence` field
    // can't express: a positive "cleanup complete" done-claim retracts, while an
    // honest "still remain" wrap-up only nudges. Both reasons are owned by the
    // canonical module; assert the split so the branch in the cleanup middleware
    // stays wired to the retract set.
    expect(isRetractableHallucination(CLEANUP_VERIFY_FALSE_DONE_REASON)).toBe(true);
    expect(isRetractableHallucination(CLEANUP_VERIFY_REASON)).toBe(false);
  });
});
