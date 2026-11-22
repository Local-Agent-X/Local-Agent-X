// A pushed-back chunk is fixed round by round. One retry and then a halt was
// the rule until a reviewer found a hole, the worker closed it, the reviewer
// found a different one, and the whole build stopped (2026-11-22): a second
// finding that is new is progress. The rounds stop when one changes nothing,
// when they run out, or when the advisor says so.
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ChunkReviewOutcome } from "../chunk-review/index.js";
import type { ParsedChunk, ParsedPlan } from "../plan-parser.js";
import type { LoopEvent } from "./types.js";

const rebuilds = vi.hoisted(() => ({ outcomes: [] as unknown[], reasons: [] as Array<string | undefined> }));
const advisor = vi.hoisted(() => ({ answers: [] as unknown[], asked: [] as string[] }));

vi.mock("./run-chunk-once.js", () => ({
  runChunkOnce: vi.fn(async (opts: { retryReason?: string }) => {
    rebuilds.reasons.push(opts.retryReason);
    return rebuilds.outcomes.shift();
  }),
}));
vi.mock("../advisor/index.js", () => ({
  consultAdvisor: vi.fn(async (input: { reviewReason: string }) => {
    advisor.asked.push(input.reviewReason);
    return advisor.answers.shift() ?? { action: "retry-with-hint", retryHint: "fix it", reasoning: "narrow fix" };
  }),
}));

const { handlePushBack, MAX_FIX_ROUNDS } = await import("./handle-push-back.js");

const chunk = { number: 5, title: "Routing rule", dependsOn: [] } as unknown as ParsedChunk;
const plan = { chunks: [chunk] } as unknown as ParsedPlan;
const report = { note: "", specGaps: "", doneWhen: "met", changed: [] } as unknown as ChunkReviewOutcome["report"];
const pushedBack = (reasoning: string): ChunkReviewOutcome =>
  ({ action: "push_back", reasoning, findings: [{ gate: "skeptic", action: "push_back", reasoning }], report }) as unknown as ChunkReviewOutcome;
const green: ChunkReviewOutcome = { action: "proceed", reasoning: "All gates passed.", findings: [], report } as unknown as ChunkReviewOutcome;

let events: Array<Omit<LoopEvent, "elapsedMs">>;
const fix = (first: ChunkReviewOutcome) => handlePushBack({
  chunk, totalChunks: 13, planPath: "spec/plan.md", plan, projectDir: "C:/proj", preSha: "abc", outcome: first,
  emit: (e) => { events.push(e); },
});

beforeEach(() => { rebuilds.outcomes = []; rebuilds.reasons = []; advisor.answers = []; advisor.asked = []; events = []; });

describe("handlePushBack", () => {
  it("a round that comes back clean ends it", async () => {
    rebuilds.outcomes = [green];
    const result = await fix(pushedBack("matches partial words"));
    expect(result.finalAction).toBe("proceed");
    expect(rebuilds.reasons).toHaveLength(1);
    expect(rebuilds.reasons[0]).toContain("fix it");
    expect(rebuilds.reasons[0]).toContain("matches partial words");
  });

  it("a second finding that is new gets another round, and the chunk lands when that one is clean", async () => {
    rebuilds.outcomes = [pushedBack("misses the hyphenated no-risk"), green];
    const result = await fix(pushedBack("matches partial words"));

    expect(result.finalAction).toBe("proceed");
    expect(rebuilds.reasons).toHaveLength(2);
    // The advisor is asked about each round's own finding.
    expect(advisor.asked).toEqual(["matches partial words", "misses the hyphenated no-risk"]);
    // The second brief carries the first finding so the fix does not reopen it.
    expect(rebuilds.reasons[1]).toContain("misses the hyphenated no-risk");
    expect(rebuilds.reasons[1]).toContain("Fixed in earlier rounds; keep them fixed:\n- matches partial words");
    expect(events.some((e) => e.type === "push-back" && e.message.includes("found something else"))).toBe(true);
  });

  it("stops when a round changes nothing: the review says the same thing again", async () => {
    rebuilds.outcomes = [pushedBack("Matches  partial words")];
    const result = await fix(pushedBack("matches partial words"));

    expect(result.finalAction).toBe("halt");
    expect(rebuilds.reasons).toHaveLength(1);
    expect(events.at(-1)?.message).toContain("changed nothing");
    // The loop decides whether the build stops; this is not a halt event.
    expect(events.some((e) => e.type === "halt")).toBe(false);
  });

  it("stops after the last round even when every round found something new", async () => {
    rebuilds.outcomes = Array.from({ length: MAX_FIX_ROUNDS + 2 }, (_, i) => pushedBack(`a different hole ${i}`));
    const result = await fix(pushedBack("the first hole"));

    expect(result.finalAction).toBe("halt");
    expect(rebuilds.reasons).toHaveLength(MAX_FIX_ROUNDS);
    expect(result.finalOutcome.reasoning).toBe(`a different hole ${MAX_FIX_ROUNDS - 1}`);
    expect(events.at(-1)?.message).toContain(`after ${MAX_FIX_ROUNDS} fix rounds`);
  });

  it("stops at once when the advisor says halt, in any round", async () => {
    advisor.answers = [{ action: "retry-with-hint", retryHint: "try" }, { action: "halt", haltReason: "the spec contradicts itself" }];
    rebuilds.outcomes = [pushedBack("a new hole")];
    const result = await fix(pushedBack("the first hole"));

    expect(result.finalAction).toBe("halt");
    expect(result.finalOutcome.reasoning).toBe("the spec contradicts itself");
    expect(rebuilds.reasons).toHaveLength(1);
  });

  it("another review outcome ends the rounds as it is", async () => {
    const amend = { ...green, action: "amend_spec" } as unknown as ChunkReviewOutcome;
    rebuilds.outcomes = [amend];
    expect((await fix(pushedBack("the first hole"))).finalAction).toBe("amend_spec");
  });
});
