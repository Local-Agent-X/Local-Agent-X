// What a chunk's judging leaves owed. "Scenarios 0/0 passed" landed every
// chunk of two builds with no scenario run and nothing on the owner's list
// (2026-11-26): a scoring run that judged nothing is owed, like one that
// could not run.
import { describe, expect, it } from "vitest";
import { chunkJudgingFinding, chunkJudgingSummary, owedFromJudging, SCENARIOS_CHECK, type ChunkJudging } from "./chunk-verdict.js";

const holds = { status: "holds" as const, finding: "tried the empty list and the long name" };
const judging = (scenarios: ChunkJudging["scenarios"]): ChunkJudging => ({ scenarios, skeptic: holds });
const score = (file: string, over: Record<string, unknown> = {}) => ({ file, score: 9, passed: true, reasoning: "", failedCriteria: [], ...over });

describe("owedFromJudging", () => {
  it("a scoring run that judged nothing is owed, never a pass", () => {
    const j = judging({ status: "scored", reason: "", scores: [] });
    expect(owedFromJudging(j)).toEqual([{ check: SCENARIOS_CHECK, why: expect.stringContaining("judged none") }]);
    // Not the builder's to fix, so not a finding against the chunk either.
    expect(chunkJudgingFinding(4, j)).toBeNull();
  });

  it("a scenario the judge cannot drive is owed by name, and the summary says it is unverified", () => {
    const j = judging({ status: "scored", reason: "", scores: [score("01-add.md"), score("06-where.md", { score: 0, passed: false, unjudged: "cannot drive: no Steps: list" })] });
    expect(owedFromJudging(j)).toEqual([{ check: SCENARIOS_CHECK, why: expect.stringContaining("06-where.md: cannot drive") }]);
    expect(chunkJudgingSummary(j)).toContain("scenarios 1/1 passed");
    expect(chunkJudgingSummary(j)).toContain("1 could not be judged, so unverified");
    expect(chunkJudgingFinding(4, j)).toBeNull();
  });

  it("scenarios that were judged and passed leave nothing owed", () => {
    expect(owedFromJudging(judging({ status: "scored", reason: "", scores: [score("01-add.md")] }))).toEqual([]);
  });
});
