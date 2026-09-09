import { describe, it, expect, vi, beforeEach } from "vitest";

// The partial-label half of this contract (second describe below) runs the REAL
// terminal-epilogue against stubbed collaborators — a declared "partial-label"
// is only provably live if the epilogue actually demotes the outcome label. Stub
// everything stateful/external it touches, plus the ledger predicates themselves
// so each can be flipped independently.
vi.mock("../event-emitter.js", () => ({ publishStreamChunk: vi.fn() }));
vi.mock("../middlewares/open-steps.js", () => ({ openStepsTerminationWarning: vi.fn(() => null) }));
vi.mock("./build-verify.js", () => ({ groundTruthSizesNote: vi.fn(() => null) }));
vi.mock("./record-outcome.js", () => ({ recordTerminalOutcome: vi.fn() }));
// Partial: retract-false-claim.ts (imported below, for the reason-string half of
// this file) reads the REAL BROWSER_HANDOFF_REASON from here — the emitting module
// owns its reason constant. Only the ledger predicate is stubbed; a full mock
// would replace the constant the retract contract is meant to check.
vi.mock("../middlewares/browser-handoff.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../middlewares/browser-handoff.js")>()),
  opGaveUpUnrecovered: vi.fn(() => false),
}));
vi.mock("../middlewares/cleanup-verify.js", () => ({ opCleanupUnverified: vi.fn(() => false) }));
vi.mock("../middlewares/verify-gate.js", () => ({
  opEditedSourceUnverified: vi.fn(() => false),
  opDeletedTestDodge: vi.fn(() => false),
}));

import {
  CLAIM_GROUNDING_RULES,
  CODEBASE_ADVICE_GROUNDING_REASON,
  CLEANUP_VERIFY_REASON,
  CLEANUP_VERIFY_FALSE_DONE_REASON,
  SOURCE_VERIFY_REASON,
} from "../../agent-guards/index.js";
import type { Op } from "../../ops/types.js";
import { isRetractableHallucination } from "./retract-false-claim.js";
import { applyTerminalEpilogue } from "./terminal-epilogue.js";
import { opCleanupUnverified } from "../middlewares/cleanup-verify.js";
import { opEditedSourceUnverified } from "../middlewares/verify-gate.js";

// Cross-seam contract. The canonical claim-grounding table (agent-guards) DECLARES
// a `consequence` per rule, but the runtime consequence is dispatched by TWO
// separate mechanisms, neither of which reads `rule.consequence`:
//
//   1. Off the guard's emitted `reason` string, in the turn loop —
//      - "retract"        → isRetractableHallucination(reason) in retract-false-claim.ts
//      - "replace-status" → reason === CODEBASE_ADVICE_GROUNDING_REASON in decide-outcome.ts
//   2. Off per-op ledger predicates, in terminal-epilogue.ts —
//      - "partial-label"  → opCleanupUnverified / opEditedSourceUnverified demote
//        the terminal outcome label. The reason string is never consulted here.
//
// Both are separately-maintained encodings of one policy, so without these tests
// the declared consequence and the real dispatch are free to drift — flip a
// consequence, rename a reason, drop a reason from RETRACTABLE_REASONS, or
// declare a partial-label with no predicate behind it, and the table silently
// lies. (That last one shipped: a "ui-done" rule declared partial-label with no
// predicate and no production caller — dead on arrival, deleted rather than
// escalated into new behavior. See claim-grounding.ts.) These assertions make
// any such mismatch fail the build. See [silent-seam-regressions].

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

/** One entry per claim-grounding rule that declares `consequence: "partial-label"`,
 *  naming the per-op ledger predicate terminal-epilogue.ts consults to realize it.
 *  This registry is the DECLARED wiring; the two tests below prove it matches both
 *  the table (bidirectionally) and the epilogue's real behavior. Predicates whose
 *  demotion does NOT come from a claim-grounding rule (opGaveUpUnrecovered,
 *  opDeletedTestDodge) are deliberately absent — they are outside this table's
 *  ownership, so a rule must never be invented to justify one. */
const PARTIAL_LABEL_LEDGER_PREDICATES: ReadonlyArray<{
  reason: string;
  predicateName: string;
  predicate: (opId: string) => boolean;
}> = [
  { reason: CLEANUP_VERIFY_REASON, predicateName: "opCleanupUnverified", predicate: opCleanupUnverified },
  { reason: SOURCE_VERIFY_REASON, predicateName: "opEditedSourceUnverified", predicate: opEditedSourceUnverified },
];

const partialLabelOp = { id: "op-partial-label", sessionId: "sess-partial-label", type: "chat_turn", ownerId: "local-user" } as unknown as Op;

/** Run the real epilogue on a terminal, otherwise-clean turn and return its label. */
function terminalLabel(): string | null {
  return applyTerminalEpilogue({
    op: partialLabelOp,
    turnIdx: 0,
    terminalReason: "done",
    assistantText: "All set.",
    buildVerifyConfirmation: "",
    toolCalls: [],
    observedTools: [],
  }, []);
}

describe("claim-grounding partial-label ↔ ledger-predicate contract", () => {
  beforeEach(() => {
    for (const { predicate } of PARTIAL_LABEL_LEDGER_PREDICATES) vi.mocked(predicate).mockReturnValue(false);
  });

  it("every partial-label rule has a ledger predicate, and every ledger predicate has a partial-label rule", () => {
    const declared = CLAIM_GROUNDING_RULES
      .filter(r => r.consequence === "partial-label")
      .map(r => r.reason)
      .sort();
    const wired = PARTIAL_LABEL_LEDGER_PREDICATES.map(p => p.reason).sort();
    // Anti-vacuity: with no partial-label rule left, an empty-vs-empty compare
    // would pass while the consequence had quietly stopped existing.
    expect(declared.length, "no rule declares partial-label — this contract would pass vacuously").toBeGreaterThan(0);
    // Bidirectional: a declared partial-label with no predicate is a dead rule
    // (the table lying about a consequence nothing realizes); a predicate with no
    // rule is orphaned wiring. Neither may stand.
    expect(wired, "partial-label rule reasons must match the wired ledger predicates exactly").toEqual(declared);
  });

  it("each wired predicate actually demotes the terminal outcome label to partial", () => {
    // Baseline: nothing flagged → clean. Without this, a predicate that had been
    // unwired could still "pass" if the label were partial for some other reason.
    expect(terminalLabel(), "an unflagged terminal turn must record clean").toBe("clean");
    for (const { predicateName, predicate } of PARTIAL_LABEL_LEDGER_PREDICATES) {
      vi.mocked(predicate).mockReturnValue(true);
      expect(terminalLabel(), `${predicateName} must be live in terminal-epilogue and demote the label`).toBe("partial");
      vi.mocked(predicate).mockReturnValue(false);
    }
  });
});
