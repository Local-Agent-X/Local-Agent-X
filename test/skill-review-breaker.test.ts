/**
 * Skill-review consecutive-failure breaker (Aug 31: hours of all-failure
 * passes, one every 5 minutes, full main-model spend, zero value). What must
 * hold:
 *   1. Three consecutive all-failure passes push the next scheduled pass to
 *      2x the poll interval; each further failure doubles the wait, capped at
 *      60 minutes.
 *   2. A streak of ten parks the job — no further scheduled runs — with one
 *      pinned warn line saying why and how it revives.
 *   3. Any pass that completes a review fully resets the breaker.
 *   4. The breaker reduces SPEND, never visibility: per-review failure warns
 *      still log, and a breaker skip leaves the queue intact.
 *   5. `force` bypasses the breaker (the manual seam — no production caller
 *      exists in src/ today; the scheduler registration is the only one) and
 *      a forced success un-parks.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { AgentTurn, ToolDefinition } from "../src/types.js";
import {
  requestSkillReview,
  runSkillReviewPass,
  registerSkillReviewRunner,
  getSkillReviewBreakerState,
  peekSkillReviewQueue,
  _resetSkillReviewQueue,
  SKILL_REVIEW_POLL_INTERVAL_MS,
  type SkillReviewDeps,
} from "../src/server/background-jobs/skill-review.js";
import {
  BREAKER_BACKOFF_AFTER,
  BREAKER_PARK_AFTER,
  BREAKER_MAX_DELAY_MS,
} from "../src/server/background-jobs/skill-review-breaker.js";

const mocks = vi.hoisted(() => ({ runAgent: vi.fn(), resolveProvider: vi.fn() }));

vi.mock("../src/canonical-loop/index.js", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  runAgentViaCanonical: mocks.runAgent,
}));
vi.mock("../src/agent-request/index.js", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  resolveProvider: mocks.resolveProvider,
}));

const T0 = new Date("2026-08-31T03:00:00Z").getTime();
const INTERVAL = SKILL_REVIEW_POLL_INTERVAL_MS;
const HEAVY_TURN = ["browser", "browser", "read", "write"];

function stubTool(name: string): ToolDefinition {
  return { name, description: `stub ${name}`, parameters: { type: "object", properties: {} }, execute: async () => ({ content: "" }) };
}

/** Deps only ever reach resolveProvider and runAgentViaCanonical, both mocked
 *  here — same one-cast pattern as skill-review-fork.test.ts. */
function fakeDeps(): SkillReviewDeps {
  return {
    config: {}, dataDir: "/tmp/unused", secretsStore: {}, security: {}, toolPolicy: {},
    allAgentTools: [stubTool("protocol")],
  } as unknown as SkillReviewDeps;
}

function turn(stopReason: AgentTurn["stopReason"], errorMessage?: string): AgentTurn {
  const t: AgentTurn = {
    messages: [],
    usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
    stopReason,
    committedWork: false,
  };
  if (errorMessage) t.errorMessage = errorMessage;
  return t;
}

let seq = 0;
function queueOne(sessionId = `chat-${seq++}`): void {
  requestSkillReview({ sessionId, toolSequence: HEAVY_TURN, transcript: "user: do\nassistant: done" });
}

/** Capture logger.warn output (createLogger routes warn through console.error). */
async function captureStderr<T>(fn: () => Promise<T>): Promise<{ result: T; lines: string[] }> {
  const lines: string[] = [];
  const spy = vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
    lines.push(args.map(String).join(" "));
  });
  try {
    return { result: await fn(), lines };
  } finally {
    spy.mockRestore();
  }
}

/** Capture logger.info output (routed through console.log). */
async function captureStdout<T>(fn: () => Promise<T>): Promise<{ result: T; lines: string[] }> {
  const lines: string[] = [];
  const spy = vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
    lines.push(args.map(String).join(" "));
  });
  try {
    return { result: await fn(), lines };
  } finally {
    spy.mockRestore();
  }
}

/** Jump the fake clock to the moment the current backoff window closes. */
function advancePastBackoff(): void {
  const s = getSkillReviewBreakerState();
  if (s.nextEligibleAt > Date.now()) vi.setSystemTime(s.nextEligibleAt);
}

/** One all-failure pass (the provider-throw path), stderr swallowed. */
async function failPass(): Promise<string[]> {
  mocks.runAgent.mockRejectedValueOnce(new Error("provider exploded"));
  queueOne();
  const { result, lines } = await captureStderr(() => runSkillReviewPass());
  expect(result).toMatchObject({ reviewed: 0, failed: 1 });
  return lines;
}

async function failUntilStreak(target: number): Promise<void> {
  for (let i = 0; i < target; i++) {
    advancePastBackoff();
    await failPass();
  }
  expect(getSkillReviewBreakerState().streak).toBe(target);
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(T0);
  _resetSkillReviewQueue();
  mocks.runAgent.mockReset();
  mocks.resolveProvider.mockReset();
  mocks.resolveProvider.mockResolvedValue({ provider: "anthropic", apiKey: "k", model: "main-model" });
  registerSkillReviewRunner(fakeDeps());
});

afterEach(() => {
  vi.useRealTimers();
});

describe("skill-review breaker: backoff", () => {
  it("opens after three all-failure passes: next scheduled pass at 2x the interval, queue intact, failure warns not muted", async () => {
    await failUntilStreak(2);
    expect(getSkillReviewBreakerState()).toMatchObject({ phase: "active", streak: 2 });

    // Third failure: a resolved-but-failed op (stopReason=error), so both the
    // throw path and the reviewFailure path provably feed the same streak.
    mocks.runAgent.mockResolvedValueOnce(turn("error", "middleware-abort: Turn aborted by repeat-output."));
    queueOne();
    const { result, lines } = await captureStderr(() => runSkillReviewPass());
    expect(result).toMatchObject({ reviewed: 0, failed: 1 });

    // Visibility: the per-review failure warn AND the state-change warn.
    expect(lines.some((l) => l.includes("Review of session") && l.includes("failed"))).toBe(true);
    expect(lines.some((l) => l.includes("breaker backing off: 3 consecutive failed passes"))).toBe(true);

    expect(getSkillReviewBreakerState()).toEqual({
      phase: "backing-off",
      streak: BREAKER_BACKOFF_AFTER,
      nextEligibleAt: Date.now() + 2 * INTERVAL,
    });

    // The next tick inside the window is refused — no model call, no drain.
    queueOne("chat-waiting");
    await expect(runSkillReviewPass()).resolves.toEqual({ reviewed: 0, failed: 0, skipped: true, reason: "breaker-backoff" });
    expect(mocks.runAgent).toHaveBeenCalledTimes(3);
    expect(peekSkillReviewQueue().map((r) => r.sessionId)).toEqual(["chat-waiting"]);

    // Once the window closes the pass runs again.
    vi.setSystemTime(Date.now() + 2 * INTERVAL);
    mocks.runAgent.mockRejectedValueOnce(new Error("still down"));
    const fourth = await captureStderr(() => runSkillReviewPass());
    expect(fourth.result).toMatchObject({ reviewed: 0, failed: 1 });
    expect(mocks.runAgent).toHaveBeenCalledTimes(4);
  });

  it("phase label tracks eligibility, not just streak: an expired window reads active again", async () => {
    await failUntilStreak(3);
    expect(getSkillReviewBreakerState()).toMatchObject({ phase: "backing-off", streak: 3 });

    // Window expires (or the queue empties mid-streak): blocks() lets every
    // tick run at normal cadence, so the telemetry must say "active" — a
    // stale "backing-off" label would misreport a normally-running job
    // indefinitely. The streak is preserved for context.
    advancePastBackoff();
    expect(getSkillReviewBreakerState()).toMatchObject({ phase: "active", streak: 3 });
  });

  it("doubles the wait per failed pass and caps at 60 minutes", async () => {
    const waits: number[] = [];
    for (let i = 0; i < BREAKER_BACKOFF_AFTER + 4; i++) {
      advancePastBackoff();
      await failPass();
      const s = getSkillReviewBreakerState();
      if (s.streak >= BREAKER_BACKOFF_AFTER) waits.push(s.nextEligibleAt - Date.now());
    }
    // Streaks 3..7 with a 5min base: 10, 20, 40, then the 60min cap holds.
    expect(waits).toEqual([2 * INTERVAL, 4 * INTERVAL, 8 * INTERVAL, BREAKER_MAX_DELAY_MS, BREAKER_MAX_DELAY_MS]);
  });

  it("an empty pass says nothing either way: the streak neither grows nor resets", async () => {
    await failUntilStreak(2);
    await expect(runSkillReviewPass()).resolves.toMatchObject({ reason: "empty" });
    expect(getSkillReviewBreakerState()).toMatchObject({ phase: "active", streak: 2 });
    await failPass();
    expect(getSkillReviewBreakerState().phase).toBe("backing-off");
  });
});

describe("skill-review breaker: park", () => {
  it("a streak of ten parks the job: one pinned warn line, then no further scheduled runs", async () => {
    await failUntilStreak(BREAKER_PARK_AFTER - 1);
    advancePastBackoff();
    const lines = await failPass();
    expect(lines.some((l) =>
      l.includes(`breaker PARKED: ${BREAKER_PARK_AFTER} consecutive failed passes`) &&
      l.includes("until server restart or a successful forced pass"),
    )).toBe(true);
    expect(getSkillReviewBreakerState()).toMatchObject({ phase: "parked", streak: BREAKER_PARK_AFTER });

    // Parked means parked — not a long backoff. A day later it still refuses,
    // spends nothing, and leaves the queue alone.
    const calls = mocks.runAgent.mock.calls.length;
    queueOne("chat-parked");
    vi.setSystemTime(Date.now() + 24 * 60 * 60 * 1000);
    await expect(runSkillReviewPass()).resolves.toEqual({ reviewed: 0, failed: 0, skipped: true, reason: "parked" });
    expect(mocks.runAgent).toHaveBeenCalledTimes(calls);
    expect(peekSkillReviewQueue().map((r) => r.sessionId)).toEqual(["chat-parked"]);
  });

  it("force bypasses the breaker and a forced success un-parks", async () => {
    await failUntilStreak(BREAKER_PARK_AFTER);
    expect(getSkillReviewBreakerState().phase).toBe("parked");

    mocks.runAgent.mockResolvedValueOnce(turn("end_turn"));
    queueOne();
    await expect(runSkillReviewPass({ force: true })).resolves.toMatchObject({ reviewed: 1, failed: 0 });
    expect(getSkillReviewBreakerState()).toEqual({ phase: "active", streak: 0, nextEligibleAt: 0 });

    // Normal cadence resumes for scheduled passes.
    mocks.runAgent.mockResolvedValueOnce(turn("end_turn"));
    queueOne();
    await expect(runSkillReviewPass()).resolves.toMatchObject({ reviewed: 1, failed: 0 });
  });

  it("a forced pass that fails leaves a parked job parked — force is a bypass, not a reset", async () => {
    await failUntilStreak(BREAKER_PARK_AFTER);
    mocks.runAgent.mockRejectedValueOnce(new Error("still down"));
    queueOne();
    const { result } = await captureStderr(() => runSkillReviewPass({ force: true })) ;
    expect(result).toMatchObject({ reviewed: 0, failed: 1 });
    expect(getSkillReviewBreakerState()).toMatchObject({ phase: "parked", streak: BREAKER_PARK_AFTER + 1 });
  });
});

describe("skill-review breaker: reset", () => {
  it("a success mid-streak fully resets, and says so", async () => {
    await failUntilStreak(BREAKER_BACKOFF_AFTER);
    advancePastBackoff();

    mocks.runAgent.mockResolvedValueOnce(turn("end_turn"));
    queueOne();
    const { result, lines } = await captureStdout(() => runSkillReviewPass());
    expect(result).toMatchObject({ reviewed: 1, failed: 0 });
    expect(lines.some((l) => l.includes("breaker reset: a pass succeeded (was backing-off, streak 3)"))).toBe(true);
    expect(getSkillReviewBreakerState()).toEqual({ phase: "active", streak: 0, nextEligibleAt: 0 });
  });

  it("one completed review in a mixed batch counts as value and resets", async () => {
    await failUntilStreak(2);
    // Three queued sessions drained in one pass: fail, succeed, fail.
    mocks.runAgent
      .mockRejectedValueOnce(new Error("boom"))
      .mockResolvedValueOnce(turn("end_turn"))
      .mockRejectedValueOnce(new Error("boom"));
    queueOne("mix-a"); queueOne("mix-b"); queueOne("mix-c");
    const { result } = await captureStderr(() => runSkillReviewPass());
    expect(result).toMatchObject({ reviewed: 1, failed: 2 });
    expect(getSkillReviewBreakerState()).toEqual({ phase: "active", streak: 0, nextEligibleAt: 0 });
  });

  it("_resetSkillReviewQueue clears breaker state so fixtures cannot bleed", async () => {
    await failUntilStreak(BREAKER_BACKOFF_AFTER);
    _resetSkillReviewQueue();
    expect(getSkillReviewBreakerState()).toEqual({ phase: "active", streak: 0, nextEligibleAt: 0 });
  });
});
