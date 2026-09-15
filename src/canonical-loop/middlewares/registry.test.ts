import { describe, it, expect } from "vitest";
import { getDefaultMiddlewareStack } from "./registry.js";
import { verifyGateMiddleware } from "./verify-gate.js";
import { loopDetectionMiddleware } from "./loop-detection.js";
import { prematureCompletionMiddleware } from "./premature-completion.js";
import { repeatFailureMiddleware } from "./repeat-failure.js";
import { instructionLedgerMiddleware } from "./instruction-ledger.js";
import { thrashGuardMiddleware } from "./thrash-guard.js";

// CLASS LOCK for the model-behavior guards. Each of these keys on structured
// evidence — repeated tool calls, a turn that committed nothing, a same-error
// spiral, settings thrash. (The guards that judged the model's WORDING were
// deleted in the prose-guard sweep; see nudge-budget.ts for what bounds the
// survivors.) They're easy to drop by accident in a registry refactor
// — and a dropped guard fails NO unit test, since each middleware's own tests
// exercise it in isolation, not its registration. This asserts the default
// safety stack actually WIRES them, by reference (not a name string), so the
// guards we built can't silently fall out of the loop.
const REQUIRED_GUARDS = [
  loopDetectionMiddleware,
  prematureCompletionMiddleware,
  repeatFailureMiddleware,
  instructionLedgerMiddleware,
  thrashGuardMiddleware,
];

describe("default middleware stack completeness", () => {
  const stack = getDefaultMiddlewareStack();

  for (const mw of REQUIRED_GUARDS) {
    it(`registers the ${mw.name} guard`, () => {
      expect(stack, `${mw.name} is missing from getDefaultMiddlewareStack()`).toContain(mw);
    });
  }

  it("instruction-ledger runs near the top, before the persistence guards (turn-0 ledger population must precede every guard that reads it)", () => {
    const ledger = stack.indexOf(instructionLedgerMiddleware);
    const loopDetect = stack.indexOf(loopDetectionMiddleware);
    expect(ledger).toBeGreaterThanOrEqual(0);
    expect(ledger).toBeLessThan(loopDetect);
  });

  it("verify-gate runs after premature-completion (a no-commit stop gets the do-the-work nudge first)", () => {
    const premature = stack.indexOf(prematureCompletionMiddleware);
    const verify = stack.indexOf(verifyGateMiddleware);
    expect(premature).toBeGreaterThanOrEqual(0);
    expect(verify).toBeGreaterThan(premature);
  });
});

// EXACT-ORDER LOCK — the whole-stack behavior-preservation guard for the
// declarative-ordering refactor. The dispatcher (host.ts:runMiddlewarePhase)
// walks this array in index order and short-circuits on the first firing
// middleware, so the emitted sequence IS the behavior. This freezes the exact
// order by name; any reorder (even one position) fails here. Do NOT edit this
// list to make it pass — a diff means the refactor changed observable order.
// (Deliberate removals are the exception: hallucination-check, auto-build-app
// and post-commit were retired 2026-07-10 after a fire-count audit — see
// registry.ts notes at orders 60/230/240.)
const EXPECTED_ORDER = [
  "mid-turn-stale",
  "office-theme-guard",
  "instruction-ledger",
  "loop-detection",
  "repeat-output",
  "premature-completion",
  "verify-gate",
  "open-steps",
  "budget-ladder",
  "post-edit-diagnostics",
  "external-change-diff",
  "app-design-guard",
  "dead-end",
  "repeat-failure",
  "thrash-guard",
];

describe("default middleware stack exact order", () => {
  it("emits the frozen ordered sequence of middleware names", () => {
    const stack = getDefaultMiddlewareStack();
    expect(stack.map(m => m.name)).toEqual(EXPECTED_ORDER);
  });
});
