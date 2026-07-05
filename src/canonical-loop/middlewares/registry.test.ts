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

  it("codebase-advice runs after operational-claim and before broad action nudges", () => {
    const operational = stack.indexOf(operationalClaimMiddleware);
    const advice = stack.indexOf(codebaseAdviceMiddleware);
    const toolSearch = stack.indexOf(toolSearchNudgeMiddleware);
    expect(operational).toBeGreaterThanOrEqual(0);
    expect(advice).toBeGreaterThan(operational);
    expect(advice).toBeLessThan(toolSearch);
  });
});
