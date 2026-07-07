import { describe, it, expect } from "vitest";
import { getDefaultMiddlewareStack } from "./registry.js";
import { loopDetectionMiddleware } from "./loop-detection.js";
import { hallucinationCheckMiddleware } from "./hallucination-check.js";
import { actionClaimMiddleware } from "./action-claim.js";
import { attributionClaimMiddleware } from "./attribution-claim.js";
import { operationalClaimMiddleware } from "./operational-claim.js";
import { codebaseAdviceMiddleware } from "./codebase-advice.js";
import { toolSearchNudgeMiddleware } from "./tool-search-nudge.js";
import { falseRefusalMiddleware } from "./false-refusal.js";
import { prematureCompletionMiddleware } from "./premature-completion.js";
import { repeatFailureMiddleware } from "./repeat-failure.js";
import { cleanupVerifyMiddleware } from "./cleanup-verify.js";
import { refuteCompletionMiddleware } from "./refute-completion.js";
import { instructionLedgerMiddleware } from "./instruction-ledger.js";
import { instructionAuditMiddleware } from "./instruction-audit.js";

// CLASS LOCK for the model-behavior guards. Each of these is a safety/quality
// guard that catches a distinct LLM failure mode (looping, fabricated actions,
// confabulated attribution, false refusals, no-tool denials, premature give-up,
// repeat-error spirals). They're easy to drop by accident in a registry refactor
// — and a dropped guard fails NO unit test, since each middleware's own tests
// exercise it in isolation, not its registration. This asserts the default
// safety stack actually WIRES them, by reference (not a name string), so the
// guards we built can't silently fall out of the loop.
const REQUIRED_GUARDS = [
  loopDetectionMiddleware,
  hallucinationCheckMiddleware,
  actionClaimMiddleware,
  attributionClaimMiddleware,
  operationalClaimMiddleware,
  codebaseAdviceMiddleware,
  toolSearchNudgeMiddleware,
  falseRefusalMiddleware,
  prematureCompletionMiddleware,
  repeatFailureMiddleware,
  instructionLedgerMiddleware,
  instructionAuditMiddleware,
];

describe("default middleware stack completeness", () => {
  const stack = getDefaultMiddlewareStack();

  for (const mw of REQUIRED_GUARDS) {
    it(`registers the ${mw.name} guard`, () => {
      expect(stack, `${mw.name} is missing from getDefaultMiddlewareStack()`).toContain(mw);
    });
  }

  it("false-refusal runs before tool-search-nudge (file-permission refusals get the grounding remedy, not the search remedy)", () => {
    const i = stack.indexOf(falseRefusalMiddleware);
    const j = stack.indexOf(toolSearchNudgeMiddleware);
    expect(i).toBeGreaterThanOrEqual(0);
    expect(i).toBeLessThan(j);
  });

  it("instruction-ledger runs near the top, before the persistence guards (turn-0 ledger population must precede every guard that reads it)", () => {
    const ledger = stack.indexOf(instructionLedgerMiddleware);
    const loopDetect = stack.indexOf(loopDetectionMiddleware);
    expect(ledger).toBeGreaterThanOrEqual(0);
    expect(ledger).toBeLessThan(loopDetect);
  });

  it("instruction-audit runs in the wrap-up band: after cleanup-verify, before refute-completion's LLM panel", () => {
    const audit = stack.indexOf(instructionAuditMiddleware);
    const cleanup = stack.indexOf(cleanupVerifyMiddleware);
    const refute = stack.indexOf(refuteCompletionMiddleware);
    expect(cleanup).toBeGreaterThanOrEqual(0);
    expect(audit).toBeGreaterThan(cleanup);
    expect(audit).toBeLessThan(refute);
  });

  it("codebase-advice runs after operational-claim and before broad action nudges", () => {
    const operational = stack.indexOf(operationalClaimMiddleware);
    const advice = stack.indexOf(codebaseAdviceMiddleware);
    const toolSearch = stack.indexOf(toolSearchNudgeMiddleware);
    expect(operational).toBeGreaterThanOrEqual(0);
    expect(advice).toBeGreaterThan(operational);
    expect(advice).toBeLessThan(toolSearch);
  });
});

// EXACT-ORDER LOCK — the whole-stack behavior-preservation guard for the
// declarative-ordering refactor. The dispatcher (host.ts:runMiddlewarePhase)
// walks this array in index order and short-circuits on the first firing
// middleware, so the emitted sequence IS the behavior. This freezes the exact
// order by name; any reorder (even one position) fails here. Do NOT edit this
// list to make it pass — a diff means the refactor changed observable order.
const EXPECTED_ORDER = [
  "mid-turn-stale",
  "office-theme-guard",
  "instruction-ledger",
  "loop-detection",
  "repeat-output",
  "hallucination-check",
  "action-claim",
  "attribution-claim",
  "operational-claim",
  "codebase-advice",
  "false-refusal",
  "tool-search-nudge",
  "broad-sweep-nudge",
  "premature-completion",
  "verify-gate",
  "cleanup-verify",
  "instruction-audit",
  "refute-completion",
  "open-steps",
  "browser-handoff",
  "self-check",
  "post-turn-detector",
  "auto-build-app",
  "post-commit",
  "post-edit-diagnostics",
  "dead-end",
  "repeat-failure",
];

describe("default middleware stack exact order", () => {
  it("emits the frozen ordered sequence of middleware names", () => {
    const stack = getDefaultMiddlewareStack();
    expect(stack.map(m => m.name)).toEqual(EXPECTED_ORDER);
  });
});
