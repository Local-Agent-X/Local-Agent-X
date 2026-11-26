// A pushed-back chunk is fixed round by round. One retry and then a halt was
// the rule until a reviewer found a hole, the worker closed it, the reviewer
// found a different one, and the whole build stopped (2026-11-22): a second
// finding that is new is progress. The rounds stop when one changes nothing,
// when they run out, or when the advisor says so.
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ChunkReviewOutcome } from "../chunk-review/index.js";
import type { ParsedChunk, ParsedPlan } from "../plan-parser.js";
import type { LoopEvent } from "./types.js";

const rebuilds = vi.hoisted(() => ({ outcomes: [] as unknown[], reasons: [] as Array<string | undefined>, wentOnFrom: [] as unknown[] }));
const advisor = vi.hoisted(() => ({ answers: [] as unknown[], asked: [] as string[] }));

vi.mock("./run-chunk-once.js", () => ({
  runChunkOnce: vi.fn(async (opts: { retryReason?: string; continueFrom?: unknown[]; onTranscript?: (m: unknown[]) => void }) => {
    rebuilds.reasons.push(opts.retryReason);
    rebuilds.wentOnFrom.push(opts.continueFrom);
    opts.onTranscript?.([{ role: "assistant", content: `worker of round ${rebuilds.reasons.length}` }]);
    return rebuilds.outcomes.shift();
  }),
}));
vi.mock("../advisor/index.js", () => ({
  consultAdvisor: vi.fn(async (input: { reviewReason: string }) => {
    advisor.asked.push(input.reviewReason);
    return advisor.answers.shift() ?? { action: "retry-with-hint", retryHint: "fix it", reasoning: "narrow fix" };
  }),
}));

const lead = vi.hoisted(() => ({ answers: [] as unknown[], asked: 0, finals: 0 }));
vi.mock("../advisor/lead-decisions.js", () => ({
  askLead: vi.fn(async (_ref: unknown, s: { final?: boolean }) => { lead.asked++; if (s.final) lead.finals++; return lead.answers.shift() ?? null; }),
}));

const { handlePushBack, MAX_FIX_ROUNDS } = await import("./handle-push-back.js");
const { MAX_LEAD_ROUNDS } = await import("./lead-rounds.js");
const { chunkReportOf } = await import("../chunk-review/chunk-report.js");

const chunk = { number: 5, title: "Routing rule", dependsOn: [] } as unknown as ParsedChunk;
const plan = { chunks: [chunk] } as unknown as ParsedPlan;
const report = chunkReportOf({ status: "done", doneWhen: "met", note: "built it", specGaps: "", launchReadiness: [], machineBlocked: [], ownerQuestion: "" });
const pushedBack = (reasoning: string): ChunkReviewOutcome =>
  ({ action: "push_back", reasoning, findings: [{ gate: "skeptic", action: "push_back", reasoning }], report }) as unknown as ChunkReviewOutcome;
const green: ChunkReviewOutcome = { action: "proceed", reasoning: "All gates passed.", findings: [], report } as unknown as ChunkReviewOutcome;

let events: Array<Omit<LoopEvent, "elapsedMs">>;
const fix = (first: ChunkReviewOutcome) => handlePushBack({
  chunk, totalChunks: 13, planPath: "spec/plan.md", plan, projectDir: "C:/proj", preSha: "abc", outcome: first,
  emit: (e) => { events.push(e); },
});

beforeEach(() => { rebuilds.outcomes = []; rebuilds.reasons = []; rebuilds.wentOnFrom = []; advisor.answers = []; advisor.asked = []; events = []; lead.answers = []; lead.asked = 0; lead.finals = 0; });

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

// label-check-sol's chunk 1 closed every finding and was set aside after three
// rounds; with a lead, the lead decides when a chunk has had enough.
describe("handlePushBack with a build lead", () => {
  const ledFix = (first: ChunkReviewOutcome) => handlePushBack({
    chunk, totalChunks: 13, planPath: "spec/plan.md", plan, projectDir: "C:/proj", preSha: "abc", outcome: first,
    emit: (e) => { events.push(e); }, buildLead: { projectDir: "C:/proj", originSessionId: "chat-x" },
  });
  const keepGoing = { action: "continue", reasoning: "progress", instruction: "close it" };

  it("keeps a chunk going past the fixed rounds while the lead says so, and a repeated finding is the lead's to judge", async () => {
    rebuilds.outcomes = [pushedBack("a"), pushedBack("a"), pushedBack("b"), pushedBack("c"), green];
    lead.answers = Array.from({ length: 5 }, () => keepGoing);
    const result = await ledFix(pushedBack("first"));
    expect(result.finalAction).toBe("proceed");
    expect(rebuilds.reasons).toHaveLength(5);
    expect(rebuilds.reasons.length).toBeGreaterThan(MAX_FIX_ROUNDS);
    expect(advisor.asked).toHaveLength(0);
    expect(events.some((e) => e.message.includes("found the same thing again — asking the build lead"))).toBe(true);
  });

  it("stops at the ceiling on cost however the lead answers", async () => {
    rebuilds.outcomes = Array.from({ length: MAX_LEAD_ROUNDS }, (_, i) => pushedBack(`finding ${i}`));
    lead.answers = Array.from({ length: MAX_LEAD_ROUNDS }, () => keepGoing);
    const result = await ledFix(pushedBack("first"));
    expect(result.finalAction).toBe("halt");
    expect(rebuilds.reasons).toHaveLength(MAX_LEAD_ROUNDS);
    expect(lead.finals).toBe(1);
  });

  // label-check-sol's chunk 3 (2026-11-25) was set aside at the ceiling with
  // two chunks behind it, the lead never asked about the last finding.
  it("at the ceiling the lead has the last word: its accept lands the chunk with no further rebuild", async () => {
    rebuilds.outcomes = Array.from({ length: MAX_LEAD_ROUNDS }, (_, i) => pushedBack(`edge ${i}`));
    lead.answers = [...Array.from({ length: MAX_LEAD_ROUNDS }, () => keepGoing), { action: "accept", reasoning: "new kinds of input", followUps: ["U+2028"] }];
    const result = await ledFix(pushedBack("first"));
    expect(result.finalAction).toBe("proceed");
    expect(rebuilds.reasons).toHaveLength(MAX_LEAD_ROUNDS);
    expect(lead.finals).toBe(1);
  });

  // Stage 2 of the build lead: "continue" goes back to the worker that built
  // the last round, which knows what it tried; "fresh" starts a new one.
  it("continue goes on with the last worker's conversation; fresh starts a new worker", async () => {
    const first = [{ role: "assistant", content: "worker of the first attempt" }];
    rebuilds.outcomes = [pushedBack("b"), pushedBack("c"), green];
    lead.answers = [keepGoing, keepGoing, { action: "fresh", reasoning: "going in circles", instruction: "start over" }];
    const result = await handlePushBack({
      chunk, totalChunks: 13, planPath: "spec/plan.md", plan, projectDir: "C:/proj", preSha: "abc", outcome: pushedBack("a"),
      emit: (e) => { events.push(e); }, buildLead: { projectDir: "C:/proj", originSessionId: "chat-x" }, lastTranscript: first as never,
    });
    expect(result.finalAction).toBe("proceed");
    expect(rebuilds.wentOnFrom).toEqual([first, [{ role: "assistant", content: "worker of round 1" }], undefined]);
  });

  // This pinned "without a lead every round starts a new worker": each round
  // re-read the whole chunk. The worker that built it goes on, lead or no
  // lead, and each round's conversation is handed to whoever keeps it.
  it("without a lead the same worker goes on too, and each round's conversation is handed on", async () => {
    const first = [{ role: "assistant", content: "worker of the first attempt" }];
    const handedOn: unknown[] = [];
    rebuilds.outcomes = [pushedBack("b"), green];
    const result = await handlePushBack({
      chunk, totalChunks: 13, planPath: "spec/plan.md", plan, projectDir: "C:/proj", preSha: "abc", outcome: pushedBack("a"),
      emit: (e) => { events.push(e); }, lastTranscript: first as never, onTranscript: (m) => { handedOn.push(m); },
    });
    expect(result.finalAction).toBe("proceed");
    expect(rebuilds.wentOnFrom).toEqual([first, [{ role: "assistant", content: "worker of round 1" }]]);
    expect(handedOn).toEqual([[{ role: "assistant", content: "worker of round 1" }], [{ role: "assistant", content: "worker of round 2" }]]);
  });

  it("with no conversation to go on from, the round starts a new worker", async () => {
    rebuilds.outcomes = [green];
    await fix(pushedBack("a"));
    expect(rebuilds.wentOnFrom).toEqual([undefined]);
  });

  it("a lead that does not answer leaves the round to the engine's rules", async () => {
    rebuilds.outcomes = [green];
    const result = await ledFix(pushedBack("first"));
    expect(result.finalAction).toBe("proceed");
    expect(lead.asked).toBe(1);
    expect(advisor.asked).toEqual(["first"]);
  });
});

// A pause stopped a chunk in fix round 6; Resume goes on from that round, not
// from round 1 with a fresh budget (orchestrator/run-control.ts).
describe("handlePushBack resumed after a pause", () => {
  it("counts from the round it was on, and says each round as it starts", async () => {
    rebuilds.outcomes = Array.from({ length: MAX_LEAD_ROUNDS }, (_, i) => pushedBack(`finding ${i}`));
    lead.answers = Array.from({ length: MAX_LEAD_ROUNDS + 1 }, () => ({ action: "continue", reasoning: "progress", instruction: "close it" }));
    const rounds: number[] = [];
    const result = await handlePushBack({
      chunk, totalChunks: 13, planPath: "spec/plan.md", plan, projectDir: "C:/proj", preSha: "abc", outcome: pushedBack("first"),
      emit: (e) => { events.push(e); }, buildLead: { projectDir: "C:/proj", originSessionId: "chat-x" },
      firstRound: 6, onRound: (n) => rounds.push(n),
    });
    expect(result.finalAction).toBe("halt");
    expect(rounds).toEqual([6, 7, 8]);
    expect(rebuilds.reasons).toHaveLength(3);
  });
});

// label-check-sol's fix 1012 spent its eight rounds and was set aside: every
// real fix it made stayed on a branch, off the app (2026-11-25).
describe("handlePushBack for a finish fix out of rounds", () => {
  const fixChunk = { number: 1012, title: "Finish fix 1: unlucky findings", phase: "Finish", dependsOn: [] } as unknown as ParsedChunk;
  const brokenOn = (ground: string, extra: Array<{ gate: string }> = []): ChunkReviewOutcome => ({
    action: "push_back", reasoning: `still: ${ground}`, report,
    findings: [...extra.map((f) => ({ ...f, action: "push_back", reasoning: "x" })), { gate: "skeptic", action: "push_back", reasoning: ground }],
    judging: { scenarios: { status: "none" }, skeptic: { status: "broken", finding: ground, ground } },
  }) as unknown as ChunkReviewOutcome;
  const capped = (last: ChunkReviewOutcome) => {
    rebuilds.outcomes = [...Array.from({ length: MAX_FIX_ROUNDS - 1 }, (_, i) => pushedBack(`hole ${i}`)), last];
    return handlePushBack({
      chunk: fixChunk, totalChunks: 4, planPath: "spec/plan.md", plan, projectDir: "C:/proj", preSha: "abc", outcome: pushedBack("first"),
      emit: (e) => { events.push(e); },
    });
  };

  it("lands with what it fixed when what is left only says the fix is incomplete", async () => {
    const result = await capped(brokenOn("1 — the cancel case still reproduces"));
    expect(result.finalAction).toBe("proceed");
    expect(result.finalOutcome.reasoning).toContain("Landed at its round cap with what it fixed");
    expect(events.at(-1)?.message).toContain("lands with what it fixed");
  });

  it("is set aside when the fix made the app worse, or its build or tests fail", async () => {
    expect((await capped(brokenOn("3 — the fix broke saving"))).finalAction).toBe("halt");
    expect((await capped(brokenOn("1 — still reproduces", [{ gate: "build-exec" }]))).finalAction).toBe("halt");
  });

  it("a plan chunk out of rounds is set aside as before", async () => {
    rebuilds.outcomes = Array.from({ length: MAX_FIX_ROUNDS }, (_, i) => brokenOn(`1 — hole ${i}`));
    expect((await fix(pushedBack("first"))).finalAction).toBe("halt");
  });
});


// The same build failure after two fix rounds running will not change on a
// third: the chunk waits for the owner instead of spending the rest of its
// rounds (label-check-sol's blocked check was retried to the ceiling, 2026-11-25).
describe("handlePushBack on a build failure that keeps coming back", () => {
  const buildFailed = (output: string): ChunkReviewOutcome => ({
    action: "push_back", reasoning: `\`npm test\` exited 1. Output tail: ${output}`, report,
    findings: [{ gate: "build-exec", action: "push_back", reasoning: `\`npm test\` exited 1. Output tail: ${output}` }],
  }) as unknown as ChunkReviewOutcome;
  const led = (first: ChunkReviewOutcome) => handlePushBack({
    chunk, totalChunks: 13, planPath: "spec/plan.md", plan, projectDir: "C:/proj", preSha: "abc", outcome: first,
    emit: (e) => { events.push(e); }, buildLead: { projectDir: "C:/proj", originSessionId: "chat-x" },
  });
  const keepGoing = () => ({ action: "continue", reasoning: "progress", instruction: "close it" });

  it("stops after it comes back unchanged twice, whatever its timings say", async () => {
    rebuilds.outcomes = [buildFailed("list.test.ts FAIL (48ms)"), buildFailed("list.test.ts FAIL (7ms)"), buildFailed("list.test.ts FAIL (9ms)")];
    lead.answers = Array.from({ length: 5 }, keepGoing);
    const result = await led(buildFailed("list.test.ts FAIL (12ms)"));
    expect(result.finalAction).toBe("halt");
    expect(rebuilds.reasons).toHaveLength(2);
    expect(events.at(-1)?.message).toContain("the same build failure came back unchanged");
  });

  it("goes on while the failure changes: another test, another count", async () => {
    rebuilds.outcomes = [buildFailed("list.test.ts FAIL: 3 of 9 failed"), buildFailed("list.test.ts FAIL: 1 of 9 failed"), buildFailed("detail.test.ts FAIL"), green];
    lead.answers = Array.from({ length: 5 }, keepGoing);
    const result = await led(buildFailed("list.test.ts FAIL: 5 of 9 failed"));
    expect(result.finalAction).toBe("proceed");
    expect(rebuilds.reasons).toHaveLength(4);
  });
});
