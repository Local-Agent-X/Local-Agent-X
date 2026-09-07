import { describe, it, expect, beforeEach } from "vitest";
import {
  assertionRepeatMiddleware, extractAssertions, normalizeAssertion,
} from "./assertion-repeat.js";
import { makeCanonicalLoopContext } from "./ctx.test-helper.js";
import { clearMiddlewareStateForOp } from "./state.js";

/** The exact sentence the recorded 160-turn op wrote eight separate times. */
const CLAIM = "Both fixes are live on prod — the CSS override and the lazy-fix body-class swap.";

let opId = "";
let seq = 0;
beforeEach(() => {
  opId = `op-assert-${seq++}`;
  clearMiddlewareStateForOp(opId);
});

function say(text: string) {
  return makeCanonicalLoopContext({ assistantContent: text, op: { id: opId } });
}

describe("extractAssertions — claims, not narration", () => {
  it("keeps a claim about state", () => {
    expect(extractAssertions(CLAIM)).toEqual([CLAIM]);
  });

  it("drops narration, questions and fragments", () => {
    const text = [
      "Let me check whether the stylesheet actually parsed on the deployed build.",
      "Should I also revert the viewport change across the other pages?",
      "Done.",
    ].join("\n");
    expect(extractAssertions(text)).toEqual([]);
  });

  it("drops markdown headings and table rows", () => {
    expect(extractAssertions("# Findings so far in this investigation")).toEqual([]);
    expect(extractAssertions("| file | status | notes about the row |")).toEqual([]);
  });
});

describe("normalizeAssertion — the same claim, different incidentals", () => {
  it("collapses byte counts and quoted values", () => {
    const a = 'The prod file is 20359 bytes and contains "min-width".';
    const b = 'The prod file is 20361 bytes and contains "visibility".';
    expect(normalizeAssertion(a)).toBe(normalizeAssertion(b));
  });

  it("keeps different claims apart", () => {
    expect(normalizeAssertion(CLAIM)).not.toBe(
      normalizeAssertion("The grey band is the desktop scrollbar, not a painted element."),
    );
  });
});

describe("assertion-repeat middleware", () => {
  it("stays silent for the first two statements of a claim", async () => {
    expect((await assertionRepeatMiddleware.afterModelCall!(say(CLAIM))).kind).toBe("continue");
    expect((await assertionRepeatMiddleware.afterModelCall!(say(CLAIM))).kind).toBe("continue");
  });

  it("nudges on the third restatement of the same conclusion", async () => {
    await assertionRepeatMiddleware.afterModelCall!(say(CLAIM));
    await assertionRepeatMiddleware.afterModelCall!(say(CLAIM));
    const r = await assertionRepeatMiddleware.afterModelCall!(say(CLAIM));
    expect(r.kind).toBe("nudge");
    expect((r as { reason?: string }).reason).toBe("assertion-repeat");
    expect((r as { message: string }).message).toContain("3 times");
  });

  it("counts restatements that differ only in incidentals", async () => {
    await assertionRepeatMiddleware.afterModelCall!(say("The prod file is 20359 bytes, unchanged."));
    await assertionRepeatMiddleware.afterModelCall!(say("The prod file is 20360 bytes, unchanged."));
    const r = await assertionRepeatMiddleware.afterModelCall!(say("The prod file is 20361 bytes, unchanged."));
    expect(r.kind).toBe("nudge");
  });

  it("never fires on an agent making different claims each turn", async () => {
    for (const claim of [
      "The header renders white across the full 390px viewport width.",
      "Duda serves phones a different HTML document than desktop browsers.",
      "The min-width floor comes from a rule our override does not outrank.",
      "The scratch harness cannot iframe prod because of X-Frame-Options.",
    ]) {
      expect((await assertionRepeatMiddleware.afterModelCall!(say(claim))).kind).toBe("continue");
    }
  });

  it("does not count one message that repeats a line twice as two turns", async () => {
    const doubled = `${CLAIM}\n${CLAIM}`;
    expect((await assertionRepeatMiddleware.afterModelCall!(say(doubled))).kind).toBe("continue");
    expect((await assertionRepeatMiddleware.afterModelCall!(say(doubled))).kind).toBe("continue");
  });

  it("stops nudging after the lifetime ceiling", async () => {
    let nudges = 0;
    for (let i = 0; i < 30; i++) {
      const r = await assertionRepeatMiddleware.afterModelCall!(say(CLAIM));
      if (r.kind === "nudge") nudges++;
    }
    expect(nudges).toBe(2);
  });

  it("ignores an empty turn", async () => {
    expect((await assertionRepeatMiddleware.afterModelCall!(say(""))).kind).toBe("continue");
  });
});
