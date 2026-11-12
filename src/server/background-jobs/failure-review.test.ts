import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getRuntimeConfig, setRuntimeConfig } from "../../config.js";
import type { AgentTurn, LAXConfig } from "../../types.js";
import type { FailurePattern } from "../../cognition/cross-session-learning/failure-patterns.js";
import type { FailureEvidence } from "../../canonical-loop/public/op-tool-failures.js";
import type { ReviewForkRequest } from "./review-fork.js";

// Pinned before the stores are touched: nothing here may read the real data dir.
const TEMP_LAX = mkdtempSync(join(tmpdir(), "lax-failure-review-"));
const ORIGINAL_LAX_DATA_DIR = process.env.LAX_DATA_DIR;
const ORIGINAL_CFG = getRuntimeConfig();
process.env.LAX_DATA_DIR = TEMP_LAX;

const posted: Array<{ signature: string; tool: string; lesson: string; sessions: number }> = [];
vi.mock("../../inbox/producers.js", () => ({
  inboxLessonProposed: (l: { signature: string; tool: string; lesson: string; sessions: number }) => { posted.push(l); },
}));

const { registerFailureReviewRunner, runFailureReviewPass, _resetFailureReview, FAILURE_REVIEW_MIN_GAP_MS, MAX_REVIEWS_PER_PASS } = await import("./failure-review.js");
const { knownFailuresPath, listKnownFailures, lastFailureReviewAt } = await import("../../cognition/cross-session-learning/known-failures.js");
const { readCapabilityGaps, capabilityGapsPath } = await import("../../cognition/cross-session-learning/capability-gaps.js");
const { FAILURE_REVIEW_SESSION_PREFIX } = await import("./failure-review-prompt.js");

afterAll(() => {
  setRuntimeConfig(ORIGINAL_CFG);
  if (ORIGINAL_LAX_DATA_DIR === undefined) delete process.env.LAX_DATA_DIR;
  else process.env.LAX_DATA_DIR = ORIGINAL_LAX_DATA_DIR;
  rmSync(TEMP_LAX, { recursive: true, force: true });
});

const NOW = 1_762_000_000_000;
const LESSON = "python3 is not on PATH on this computer; python runs the same interpreter.";

function pattern(n: number, over: Partial<FailurePattern> = {}): FailurePattern {
  return {
    signature: `sig-${n}`, tool: "bash", status: "error", reason: `failure number ${n}`,
    count: 6, sessions: 3, days: 2, firstSeen: NOW - 1000, lastSeen: NOW,
    samples: [
      { sessionId: `chat-${n}-a`, at: NOW, opId: `op-${n}-a`, toolCallId: "c1" },
      { sessionId: `chat-${n}-b`, at: NOW - 1, opId: `op-${n}-b`, toolCallId: "c1" },
    ],
    ...over,
  };
}

function reply(text: string, stopReason: AgentTurn["stopReason"] = "end_turn"): AgentTurn {
  return { messages: [{ role: "assistant", content: text }], usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 }, stopReason };
}

interface Harness {
  forks: ReviewForkRequest[];
  proposed: string[];
  evidenceCalls: string[];
}

function setup(opts: {
  patterns: FailurePattern[];
  verdict?: (request: ReviewForkRequest) => AgentTurn | Promise<AgentTurn>;
  evidence?: (opId: string) => FailureEvidence | null;
  now?: () => number;
  announce?: boolean;
}): Harness {
  const h: Harness = { forks: [], proposed: [], evidenceCalls: [] };
  registerFailureReviewRunner({
    config: {} as LAXConfig, dataDir: TEMP_LAX, secretsStore: {} as never, security: {} as never, toolPolicy: {} as never,
    now: opts.now ?? (() => NOW),
    recurring: async () => opts.patterns,
    evidenceFor: (opId) => {
      h.evidenceCalls.push(opId);
      return opts.evidence ? opts.evidence(opId) : { text: `[FAILED CALL] for ${opId}`, recovered: true };
    },
    runFork: async (request) => {
      h.forks.push(request);
      return opts.verdict ? opts.verdict(request) : reply(JSON.stringify({ verdict: "noise", why: "a site that was down" }));
    },
    ...(opts.announce ? {} : { onProposed: (lesson) => { h.proposed.push(lesson.signature); } }),
  });
  return h;
}

beforeEach(() => {
  _resetFailureReview();
  posted.length = 0;
  rmSync(knownFailuresPath(), { force: true });
  rmSync(capabilityGapsPath(), { force: true });
  setRuntimeConfig({ ...ORIGINAL_CFG, failureReviewEnabled: true } as LAXConfig);
});

describe("runFailureReviewPass — when it spends nothing", () => {
  it("does nothing before the server has registered it", async () => {
    expect(await runFailureReviewPass()).toMatchObject({ skipped: true, reason: "no-runner" });
  });

  it("makes no model call when nothing keeps going wrong, and still counts as today's look", async () => {
    const h = setup({ patterns: [] });
    expect(await runFailureReviewPass()).toEqual({ reviewed: 0, proposed: 0, failed: 0, skipped: false });
    expect(h.forks).toEqual([]);
    expect(lastFailureReviewAt()).toBe(NOW);
  });

  it("makes no model call while the switch is off, and does not use up the day", async () => {
    setRuntimeConfig({ ...getRuntimeConfig(), failureReviewEnabled: false } as LAXConfig);
    const h = setup({ patterns: [pattern(1)] });
    expect(await runFailureReviewPass({ force: true })).toMatchObject({ skipped: true, reason: "disabled" });
    expect(h.forks).toEqual([]);
    expect(lastFailureReviewAt()).toBe(0);
  });

  it("runs at most once a day, unless forced", async () => {
    let now = NOW;
    const h = setup({ patterns: [pattern(1)], now: () => now });
    expect((await runFailureReviewPass()).reviewed).toBe(1);
    now += FAILURE_REVIEW_MIN_GAP_MS - 1;
    expect(await runFailureReviewPass()).toMatchObject({ skipped: true, reason: "recent" });
    now += 1;
    expect((await runFailureReviewPass()).skipped).toBe(false);
    expect(h.forks).toHaveLength(1); // the second real pass found nothing new to review
  });

  it("never reviews a refused call, or a failure already decided", async () => {
    const h = setup({ patterns: [pattern(1, { status: "blocked", layer: "security" }), pattern(2)] });
    await runFailureReviewPass();
    expect(h.forks).toHaveLength(1);
    await runFailureReviewPass({ force: true });
    expect(h.forks).toHaveLength(1);
    expect(listKnownFailures().map((k) => k.signature)).toEqual(["sig-2"]);
  });

  it("looks again at noise only once it has spread to twice the chats", async () => {
    const patterns = [pattern(1, { sessions: 3 })];
    const h = setup({ patterns });
    await runFailureReviewPass();
    patterns[0] = pattern(1, { sessions: 5 });
    await runFailureReviewPass({ force: true });
    expect(h.forks).toHaveLength(1);
    patterns[0] = pattern(1, { sessions: 6 });
    await runFailureReviewPass({ force: true });
    expect(h.forks).toHaveLength(2);
  });

  it("reviews at most the cap per pass and leaves the rest for tomorrow", async () => {
    const h = setup({ patterns: Array.from({ length: MAX_REVIEWS_PER_PASS + 3 }, (_, i) => pattern(i)) });
    expect((await runFailureReviewPass()).reviewed).toBe(MAX_REVIEWS_PER_PASS);
    expect(h.forks).toHaveLength(MAX_REVIEWS_PER_PASS);
  });

  it("skips a failure whose runs no longer hold the calls, without a model call or a record", async () => {
    const h = setup({ patterns: [pattern(1)], evidence: () => null });
    expect(await runFailureReviewPass()).toMatchObject({ reviewed: 0, failed: 0 });
    expect(h.forks).toEqual([]);
    expect(listKnownFailures()).toEqual([]);
  });
});

describe("runFailureReviewPass — what a review does", () => {
  it("runs a tool-less fork over the samples, under its own op type and an internal session", async () => {
    const h = setup({ patterns: [pattern(7, { action: "read", tool: "office" })] });
    await runFailureReviewPass();
    const [fork] = h.forks;
    expect(fork.tools).toEqual([]);
    expect(fork.opType).toBe("failure_review");
    expect(fork.forkSessionId.startsWith(FAILURE_REVIEW_SESSION_PREFIX)).toBe(true);
    expect(fork.section).toEqual({ id: "failure-review", label: "Failure Review" });
    expect(h.evidenceCalls).toEqual(["op-7-a", "op-7-b"]);
    // The counts and every sample are inside the one data fence.
    const fenceOpen = fork.message.indexOf("untrusted-recalled-data");
    const fenceClose = fork.message.lastIndexOf("untrusted-recalled-data");
    for (const part of ["Tool: office (action: read)", "First line of the failure: failure number 7", "Seen: 6 times in 3 chats on 2 days", "[FAILED CALL] for op-7-a", "[FAILED CALL] for op-7-b"]) {
      const at = fork.message.indexOf(part);
      expect(at, part).toBeGreaterThan(fenceOpen);
      expect(at, part).toBeLessThan(fenceClose);
    }
  });

  it("stores a lesson as proposed and tells the user it is waiting", async () => {
    const h = setup({ patterns: [pattern(1)], verdict: () => reply("```json\n" + JSON.stringify({ verdict: "lesson", lesson: LESSON, why: "the retry with python worked in every sample" }) + "\n```") });
    expect(await runFailureReviewPass()).toEqual({ reviewed: 1, proposed: 1, failed: 0, skipped: false });
    expect(listKnownFailures()[0]).toMatchObject({ signature: "sig-1", verdict: "lesson", state: "proposed", lesson: LESSON, sessions: 3 });
    expect(h.proposed).toEqual(["sig-1"]);
  });

  it("posts the waiting lesson to the inbox", async () => {
    setup({ patterns: [pattern(1)], announce: true, verdict: () => reply(JSON.stringify({ verdict: "lesson", lesson: LESSON, why: "x" })) });
    await runFailureReviewPass();
    expect(posted).toEqual([{ signature: "sig-1", tool: "bash", lesson: LESSON, sessions: 3 }]);
  });

  it("does not accept a lesson when no sample shows the same call working afterwards", async () => {
    const h = setup({
      patterns: [pattern(1)],
      evidence: (opId) => ({ text: `sample ${opId}`, recovered: false }),
      verdict: () => reply(JSON.stringify({ verdict: "lesson", lesson: LESSON, why: "it looked fixable" })),
    });
    expect(await runFailureReviewPass()).toMatchObject({ reviewed: 1, proposed: 0 });
    const [known] = listKnownFailures();
    expect(known.verdict).toBe("noise");
    expect(known.lesson).toBeUndefined();
    expect(known.why).toContain("No sample shows the same call succeeding afterwards");
    expect(h.proposed).toEqual([]);
  });

  it("records an app gap where the maintainer will see it", async () => {
    setup({ patterns: [pattern(1, { tool: "memory_search" })], verdict: () => reply(JSON.stringify({ verdict: "app_gap", why: "the search cannot see the raw session logs" })) });
    await runFailureReviewPass();
    expect(listKnownFailures()[0]).toMatchObject({ verdict: "app_gap" });
    expect(readCapabilityGaps()).toEqual([{
      sessionId: "chat-1-a", timestamp: NOW, toolsTried: ["memory_search"],
      summary: "memory_search keeps failing: failure number 1. the search cannot see the raw session logs",
    }]);
  });

  it("counts a reply that is not a verdict as a failed review and records nothing", async () => {
    setup({ patterns: [pattern(1)], verdict: () => reply("I think this is probably fine.") });
    expect(await runFailureReviewPass()).toMatchObject({ reviewed: 0, failed: 1 });
    expect(listKnownFailures()).toEqual([]);
  });

  it("counts a run that ended failed or cancelled as a failed review", async () => {
    setup({ patterns: [pattern(1)], verdict: () => reply(JSON.stringify({ verdict: "noise", why: "x" }), "error") });
    expect(await runFailureReviewPass()).toMatchObject({ reviewed: 0, failed: 1 });
    expect(listKnownFailures()).toEqual([]);
  });

  it("gives up for the day after two reviews fail in a row", async () => {
    const h = setup({ patterns: [pattern(1), pattern(2), pattern(3), pattern(4)], verdict: () => { throw new Error("provider is down"); } });
    expect(await runFailureReviewPass()).toMatchObject({ reviewed: 0, failed: 2 });
    expect(h.forks).toHaveLength(2);
  });

  it("carries on past one failed review", async () => {
    let n = 0;
    setup({ patterns: [pattern(1), pattern(2), pattern(3)], verdict: () => { if (n++ === 0) throw new Error("timeout"); return reply(JSON.stringify({ verdict: "noise", why: "x" })); } });
    expect(await runFailureReviewPass()).toMatchObject({ reviewed: 2, failed: 1 });
  });
});
