import { describe, it, expect } from "vitest";
import { composeDigest, goalRestateAfterTurn } from "./situational-awareness.js";
import type { LedgerAction } from "../../ops/action-ledger.js";

function acts(...pairs: Array<[string, "ok" | "error" | "cancelled"]>): LedgerAction[] {
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

  it("renders the token total in the pace line", () => {
    const d = composeDigest({ turnIdx: 2, totalTokens: 5000, recent: [], firstUserText: "" });
    expect(d).toContain("~5k tokens used so far");
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
