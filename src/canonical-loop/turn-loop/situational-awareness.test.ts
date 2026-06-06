import { describe, it, expect } from "vitest";
import { composeDigest } from "./situational-awareness.js";
import type { OpTurnRow } from "../types.js";

function turn(tools: Array<[string, "ok" | "error" | "cancelled"]>, usage?: { in: number; out: number }): OpTurnRow {
  return {
    opId: "op1",
    turnIdx: 0,
    providerState: {
      adapterName: "anthropic",
      adapterVersion: "1",
      providerPayload: usage ? { usageInputTokens: usage.in, usageOutputTokens: usage.out } : {},
    },
    toolCallSummary: tools.map(([tool, resultStatus]) => ({ tool, argsHash: "h", resultStatus, durationMs: 1 })),
    terminalReason: "done",
    redirectConsumed: false,
    createdAt: "2026-06-06T00:00:00Z",
  };
}

describe("composeDigest", () => {
  it("turn 0 returns null (fresh request, nothing to summarize)", () => {
    expect(composeDigest({ turnIdx: 0, turns: [], firstUserText: "x" })).toBeNull();
  });

  it("always includes a pace line once past turn 0", () => {
    const d = composeDigest({ turnIdx: 1, turns: [], firstUserText: "" });
    expect(d).toContain("Turn 2 of this request");
  });

  it("summarizes recent tool actions with outcome marks", () => {
    const d = composeDigest({
      turnIdx: 2,
      turns: [turn([["edit", "ok"]]), turn([["bash", "error"]])],
      firstUserText: "",
    });
    expect(d).toContain("Recent actions: edit✓, bash✗");
  });

  it("sums token usage across turns into the pace line", () => {
    const d = composeDigest({
      turnIdx: 2,
      turns: [turn([], { in: 1000, out: 500 }), turn([], { in: 2000, out: 1500 })],
      firstUserText: "",
    });
    expect(d).toContain("~5k tokens used so far");
  });

  it("omits the goal restatement until the request has scrolled away", () => {
    const early = composeDigest({ turnIdx: 2, turns: [], firstUserText: "build the thing" });
    expect(early).not.toContain("Original request");
    const late = composeDigest({ turnIdx: 6, turns: [], firstUserText: "build the thing" });
    expect(late).toContain('Original request: "build the thing"');
  });

  it("clips a long goal restatement", () => {
    const long = "a".repeat(300);
    const d = composeDigest({ turnIdx: 6, turns: [], firstUserText: long });
    expect(d).toContain("…");
    expect(d!.length).toBeLessThan(300);
  });
});
