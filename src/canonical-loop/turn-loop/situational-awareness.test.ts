import { describe, it, expect } from "vitest";
import { composeDigest, goalRestateAfterTurn } from "./situational-awareness.js";
import type { LedgerAction } from "../../ops/action-ledger.js";

function acts(...pairs: Array<[string, LedgerAction["status"]]>): LedgerAction[] {
  return pairs.map(([tool, status]) => ({ tool, status }));
}

describe("composeDigest", () => {
  it("returns null when there's nothing useful (turn 0, no recent actions)", () => {
    expect(composeDigest({ turnIdx: 0, totalTokens: 0, recent: [], firstUserText: "x" })).toBeNull();
  });

  it("shows recent actions even at turn 0 (fresh message / voice utterance)", () => {
    const d = composeDigest({ turnIdx: 0, totalTokens: 0, recent: acts(["edit", "ok"]), firstUserText: "" });
    expect(d).toContain("Recent actions");
    expect(d).toContain("edit✓");
    expect(d).not.toContain("Turn 1"); // pace suppressed at turn 0
  });

  it("includes a pace line once past turn 0", () => {
    const d = composeDigest({ turnIdx: 1, totalTokens: 0, recent: [], firstUserText: "" });
    expect(d).toContain("Turn 2 of this request");
  });

  it("summarizes recent cross-conversation actions with outcome marks", () => {
    const d = composeDigest({
      turnIdx: 2,
      totalTokens: 0,
      recent: acts(["edit", "ok"], ["bash", "error"], ["web_search", "cancelled"]),
      firstUserText: "",
    });
    expect(d).toContain("edit✓, bash✗, web_search⊘");
  });

  // Regression (dispatch-status widening): the digest stays binary — every
  // failure flavor renders ✗, ⊘ stays reserved for cancelled. New labels must
  // not leak into this ephemeral line.
  it("renders widened failure flavors as plain ✗", () => {
    const d = composeDigest({
      turnIdx: 2,
      totalTokens: 0,
      recent: acts(["bash", "blocked"], ["edit", "declined"], ["web_fetch", "timeout"]),
      firstUserText: "",
    });
    expect(d).toContain("bash✗, edit✗, web_fetch✗");
    expect(d).not.toContain("blocked");
    expect(d).not.toContain("declined");
    expect(d).not.toContain("timeout");
  });

  it("renders the token total in the pace line", () => {
    const d = composeDigest({ turnIdx: 2, totalTokens: 5000, recent: [], firstUserText: "" });
    expect(d).toContain("~5k tokens used so far");
  });

  it("re-anchors the durable open plan every turn — even at turn 0, before any restate", () => {
    const d = composeDigest({
      turnIdx: 0, totalTokens: 0, recent: [], firstUserText: "build a todo app",
      openTasks: [
        { id: "t1", description: "scaffold the HTML" },
        { id: "t2", description: "wire up add/remove" },
      ],
    });
    expect(d).toContain("Open plan steps still to finish");
    expect(d).toContain("1. scaffold the HTML");
    expect(d).toContain("2. wire up add/remove");
    // The plan shows independently of the goal-restate gate.
    expect(d).not.toContain("Original request");
  });

  it("caps the plan and notes the overflow", () => {
    const openTasks = Array.from({ length: 15 }, (_, i) => ({ id: `t${i}`, description: `step ${i}` }));
    const d = composeDigest({ turnIdx: 1, totalTokens: 0, recent: [], firstUserText: "", openTasks })!;
    expect(d).toContain("(+3 more)");
    expect(d).toContain("12. step 11");
    expect(d).not.toContain("13. step 12");
  });

  it("omits the plan line when there are no open tasks", () => {
    const d = composeDigest({ turnIdx: 1, totalTokens: 0, recent: [], firstUserText: "", openTasks: [] });
    expect(d).not.toContain("Open plan steps");
  });

  it("omits the goal restatement until the request has scrolled away", () => {
    const early = composeDigest({ turnIdx: 2, totalTokens: 0, recent: [], firstUserText: "build the thing" });
    expect(early).not.toContain("Original request");
    const late = composeDigest({ turnIdx: 6, totalTokens: 0, recent: [], firstUserText: "build the thing" });
    expect(late).toContain('Original request: "build the thing"');
  });

  it("clips a long goal restatement", () => {
    const long = "a".repeat(300);
    const d = composeDigest({ turnIdx: 6, totalTokens: 0, recent: [], firstUserText: long });
    expect(d).toContain("…");
    // Goal line clips at GOAL_MAX_CHARS(160); the rest is the fixed
    // header/footer + pace line. Bound = clipped goal + ~200 of frame.
    expect(d!.length).toBeLessThan(360);
  });

  it("carries success criteria + hard constraints into the re-grounding block", () => {
    const d = composeDigest({
      turnIdx: 6,
      totalTokens: 0,
      recent: [],
      firstUserText: "ship the export feature",
      successCriteria: ["CSV downloads", "covered by a test"],
      constraints: ["do not touch auth"],
    });
    expect(d).toContain("Success criteria (all must hold before you finish): CSV downloads; covered by a test");
    expect(d).toContain("Hard constraints (do not violate): do not touch auth");
  });

  it("omits criteria/constraints before the restate threshold", () => {
    const d = composeDigest({
      turnIdx: 2,
      totalTokens: 0,
      recent: acts(["edit", "ok"]),
      firstUserText: "ship it",
      successCriteria: ["CSV downloads"],
      constraints: ["do not touch auth"],
      restateAfter: 6,
    });
    expect(d).not.toContain("Success criteria");
    expect(d).not.toContain("Hard constraints");
  });

  it("re-grounds weaker tiers earlier than strong tiers (tier-aware cadence)", () => {
    expect(goalRestateAfterTurn("weak")).toBe(3);
    expect(goalRestateAfterTurn("medium")).toBe(4);
    expect(goalRestateAfterTurn("strong")).toBe(6);
    expect(goalRestateAfterTurn(undefined)).toBe(6);

    // At turn 3 a weak model already gets its criteria; a strong model does not.
    const common = { turnIdx: 3, totalTokens: 0, recent: [] as LedgerAction[], firstUserText: "do X", successCriteria: ["passes CI"] };
    const weak = composeDigest({ ...common, restateAfter: goalRestateAfterTurn("weak") });
    const strong = composeDigest({ ...common, restateAfter: goalRestateAfterTurn("strong") });
    expect(weak).toContain("Success criteria");
    expect(strong).not.toContain("Success criteria");
  });
});
