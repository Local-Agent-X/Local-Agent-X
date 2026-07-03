import { describe, it, expect, vi, beforeEach } from "vitest";

// Control the panel verdict so we can assert refuteClaim's mapping without
// touching any provider. The tally itself is tested in verify-by-refutation.test.ts.
// vi.hoisted: refute-claim.ts imports verify-by-refutation STATICALLY, so the
// hoisted vi.mock factory runs at import time — the mock fn must exist by then.
const { verifyMock } = vi.hoisted(() => ({ verifyMock: vi.fn() }));
vi.mock("./verify-by-refutation.js", () => ({ verifyByRefutation: verifyMock }));

import { refuteClaim } from "./refute-claim.js";

type Vote = { refuted: boolean | null; reason: string; lens?: string };
function mkVerdict(votes: Vote[], verdict: "refuted" | "holds" | "inconclusive") {
  return {
    verdict,
    refutedCount: votes.filter((v) => v.refuted === true).length,
    holdsCount: votes.filter((v) => v.refuted === false).length,
    nullCount: votes.filter((v) => v.refuted === null).length,
    voters: votes.length,
    votes,
  };
}

describe("refuteClaim", () => {
  beforeEach(() => verifyMock.mockReset());

  it("reports refuted:true with the refuting skeptics' reasons on a majority refutation", async () => {
    verifyMock.mockResolvedValue(
      mkVerdict(
        [
          { refuted: true, reason: "build breaks" },
          { refuted: true, reason: "no test added" },
          { refuted: false, reason: "otherwise fine" },
        ],
        "refuted",
      ),
    );
    const r = await refuteClaim({ claim: "the task is done" });
    expect(r.refuted).toBe(true);
    expect(r.reasons).toEqual(["build breaks", "no test added"]);
    expect(r.summary).toBe("2/3 skeptics refuted the claim");
  });

  it("fails OPEN: 'holds' and 'inconclusive' both yield refuted:false with no reasons", async () => {
    verifyMock.mockResolvedValue(mkVerdict([{ refuted: false, reason: "" }, { refuted: false, reason: "" }, { refuted: true, reason: "x" }], "holds"));
    expect((await refuteClaim({ claim: "x" })).refuted).toBe(false);

    verifyMock.mockResolvedValue(mkVerdict([{ refuted: null, reason: "" }, { refuted: null, reason: "" }, { refuted: null, reason: "" }], "inconclusive"));
    const r = await refuteClaim({ claim: "x" });
    expect(r.refuted).toBe(false);
    expect(r.reasons).toEqual([]);
  });

  it("only collects reasons from REFUTING votes that actually gave one", async () => {
    verifyMock.mockResolvedValue(
      mkVerdict(
        [
          { refuted: true, reason: "" },        // refuted but no reason → excluded
          { refuted: true, reason: "real reason" },
          { refuted: true, reason: "   " },     // whitespace only → excluded
        ],
        "refuted",
      ),
    );
    expect((await refuteClaim({ claim: "x" })).reasons).toEqual(["real reason"]);
  });

  it("weaves the claim + context into the panel prompt and uses 3 default lenses", async () => {
    verifyMock.mockResolvedValue(mkVerdict([{ refuted: false, reason: "" }], "holds"));
    await refuteClaim({ claim: "CLAIM-MARKER", context: "EVIDENCE-MARKER" });
    const arg = verifyMock.mock.calls[0][0];
    expect(arg.userPrompt).toContain("CLAIM-MARKER");
    expect(arg.userPrompt).toContain("EVIDENCE-MARKER");
    expect(arg.lenses).toHaveLength(3);
    expect(arg.category).toBe("refute-claim");
  });
});
