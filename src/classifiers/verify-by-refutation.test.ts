import { describe, it, expect } from "vitest";
import { tallyRefutation, type RefutationVote } from "./verify-by-refutation.js";

const refute = (reason = "flaw", lens?: string): RefutationVote => ({ refuted: true, reason, lens });
const holds = (reason = "", lens?: string): RefutationVote => ({ refuted: false, reason, lens });
const nul = (lens?: string): RefutationVote => ({ refuted: null, reason: "", lens });

describe("tallyRefutation", () => {
  it("returns 'refuted' on a strict majority of YES votes", () => {
    const v = tallyRefutation([refute("build breaks"), refute("no test"), holds()]);
    expect(v.verdict).toBe("refuted");
    expect(v.refutedCount).toBe(2);
    expect(v.holdsCount).toBe(1);
    expect(v.voters).toBe(3);
  });

  it("returns 'holds' on a strict majority of NO votes", () => {
    const v = tallyRefutation([holds(), holds(), refute()]);
    expect(v.verdict).toBe("holds");
    expect(v.holdsCount).toBe(2);
  });

  it("is 'inconclusive' without a majority (split with a null)", () => {
    expect(tallyRefutation([refute(), holds(), nul()]).verdict).toBe("inconclusive");
  });

  it("is 'inconclusive' when every voter is unavailable", () => {
    const v = tallyRefutation([nul(), nul(), nul()]);
    expect(v.verdict).toBe("inconclusive");
    expect(v.nullCount).toBe(3);
  });

  it("is 'inconclusive' with zero voters", () => {
    const v = tallyRefutation([]);
    expect(v).toMatchObject({ verdict: "inconclusive", voters: 0, refutedCount: 0 });
  });

  it("uses strict majority — 2 of 4 refuted does NOT refute (threshold 3)", () => {
    expect(tallyRefutation([refute(), refute(), holds(), holds()]).verdict).toBe("inconclusive");
  });

  it("preserves the per-voter ballots (reasons + lenses) in the verdict", () => {
    const votes = [refute("A", "correctness"), holds("B", "security")];
    const v = tallyRefutation(votes);
    expect(v.votes).toEqual(votes);
    expect(v.votes[0].reason).toBe("A");
    expect(v.votes[0].lens).toBe("correctness");
  });
});
