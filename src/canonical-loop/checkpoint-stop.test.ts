/**
 * Unit coverage for the checkpoint stop predicate.
 *
 * The worker-level behaviour (interactive continues past maxIterations; stops
 * on dry checkpoints) is proved end-to-end in
 * test/worker-honors-iteration-budget.test.ts against a real worker with the
 * real loop-detection middleware. This file pins the predicate itself:
 *
 *   - the dry signal is the MONOTONIC novelty counter, not the size of a
 *     capped Set (the saturation lie that got the first version reverted);
 *   - the spend ceiling binds on real API-key spend against BOTH budgets, and
 *     at the schema DEFAULTS, not only when a user opts in;
 *   - the subscription carve-out is judged per-op from the op's own
 *     credential, never from the process-global "last resolved" source.
 */
import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { mkdtempSync, rmSync, existsSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// cost-tracker binds its usage-log path at import time, so LAX_DATA_DIR must be
// redirected before the dynamic imports below — same discipline as
// tool-policy/packs/spend-cap-pack.test.ts.
const prevLaxDir = process.env.LAX_DATA_DIR;
const tmp = mkdtempSync(join(tmpdir(), "lax-checkpoint-stop-"));
process.env.LAX_DATA_DIR = tmp;
afterAll(() => {
  if (prevLaxDir === undefined) delete process.env.LAX_DATA_DIR;
  else process.env.LAX_DATA_DIR = prevLaxDir;
  rmSync(tmp, { recursive: true, force: true });
});

const { trackUsage, noteResolvedAuthSource } = await import("../cost-tracker.js");
const { setRuntimeConfig, loadConfig } = await import("../config.js");
const { configSchema } = await import("../config-schema.js");
const { getMiddlewareState, _resetMiddlewareStates } = await import("./middlewares/state.js");
const { createLoopState, noteToolResults } = await import("../agent-guards/loop-detection.js");
const { RESULT_SIG_MEMORY } = await import("../agent-guards/loop-progress.js");
const { evaluateCheckpointStop } = await import("./checkpoint-stop.js");
type LoopState = import("../agent-guards/loop-detection.js").LoopState;
type Op = import("../ops/types.js").Op;
type CredentialSource = import("../ops/types.js").Op["contextPack"]["routing"]["authSource"];

const SESSION = "sess-checkpoint-stop";

function mkOp(id: string, authSource: CredentialSource = "env", sessionId: string = SESSION): Op {
  return {
    id,
    sessionId,
    type: "chat_turn",
    task: "checkpoint stop",
    contextPack: {
      budget: { maxIterations: 160, maxTokens: 0, maxWallTimeMs: 0, maxSelfEditCalls: 0 },
      routing: { lane: "interactive", authSource },
    } as Op["contextPack"],
    lane: "interactive",
    retryPolicy: { maxRecoveryAttempts: 3, backoffMs: [5_000] },
    ownerId: "test",
    visibility: "private",
    status: "pending",
    createdAt: new Date().toISOString(),
    attemptCount: 0,
  };
}

function setBudgets(daily: number, session: number): void {
  setRuntimeConfig({ ...loadConfig(), dailyBudgetUsd: daily, sessionBudgetUsd: session, modelDailyBudgetsUsd: {} });
}

function loopOf(opId: string): LoopState {
  return getMiddlewareState<LoopState>(opId, "loop-detection", createLoopState);
}

/** Feed the op `n` DISTINCT tool results through the real noteToolResults, so
 *  the novelty counter moves the way production moves it. */
let resultSeq = 0;
const lastLearned = new Map<string, string>();
function learn(opId: string, n: number): void {
  const state = loopOf(opId);
  for (let i = 0; i < n; i++) {
    const call = [{ name: "search", arguments: `{"q":"${resultSeq}"}` }];
    const content = `finding-${opId}-${resultSeq++}`;
    lastLearned.set(opId, content);
    noteToolResults(call, state, [{ content, status: "ok" }]);
  }
}

/** Feed the op a result it has ALREADY seen (its most recent one) — learns
 *  nothing. A fresh literal would itself be novel the first time. */
function repeat(opId: string, n: number): void {
  const state = loopOf(opId);
  const content = lastLearned.get(opId);
  if (content === undefined) throw new Error(`repeat() before learn() for ${opId}`);
  for (let i = 0; i < n; i++) {
    noteToolResults([{ name: "search", arguments: "{}" }], state, [{ content, status: "ok" }]);
  }
}

// $6 of opus output tokens (25/M output).
function spend6Usd(authSource: "env" | "oauth", sessionId: string = SESSION): void {
  trackUsage(sessionId, "claude-opus-4-8", "anthropic", 0, 240_000, undefined, authSource);
}

beforeEach(() => {
  _resetMiddlewareStates();
  const usageFile = join(tmp, "usage-log.json");
  if (existsSync(usageFile)) unlinkSync(usageFile);
  setBudgets(0, 0);
  noteResolvedAuthSource("env");
});

describe("evaluateCheckpointStop — dry checkpoints (monotonic counter)", () => {
  it("continues while every checkpoint has learned something new", () => {
    const op = mkOp("op-progress");
    learn(op.id, 2);
    expect(evaluateCheckpointStop(op)).toMatchObject({ stop: false, reason: null });
    learn(op.id, 1);
    expect(evaluateCheckpointStop(op)).toMatchObject({ stop: false, reason: null });
    learn(op.id, 1);
    expect(evaluateCheckpointStop(op)).toMatchObject({ stop: false, reason: null });
  });

  it("stops after two consecutive checkpoints that learned nothing", () => {
    const op = mkOp("op-dry");
    learn(op.id, 3);
    // 1st: no prior count to compare against.
    expect(evaluateCheckpointStop(op).stop).toBe(false);
    repeat(op.id, 5);
    // 2nd: dry once — one dry checkpoint is not enough.
    expect(evaluateCheckpointStop(op).stop).toBe(false);
    repeat(op.id, 5);
    // 3rd: two in a row.
    const d = evaluateCheckpointStop(op);
    expect(d).toMatchObject({ stop: true, reason: "dry-checkpoints" });
    expect(d.detail).toContain("3 distinct results");
  });

  it("one new result between dry checkpoints resets the streak", () => {
    const op = mkOp("op-reset");
    learn(op.id, 1);
    evaluateCheckpointStop(op);
    repeat(op.id, 2);
    expect(evaluateCheckpointStop(op).stop).toBe(false); // dry 1
    learn(op.id, 1);
    expect(evaluateCheckpointStop(op).stop).toBe(false); // streak reset
    repeat(op.id, 2);
    expect(evaluateCheckpointStop(op).stop).toBe(false); // dry 1 again
  });

  // REGRESSION (the reason the first version was reverted). loop-detection's
  // seenResultSigs is a FIFO capped at RESULT_SIG_MEMORY; past that many
  // distinct results its .size is pinned, so a size comparison across
  // checkpoints read every long, productive op as "dry" and killed it. The
  // predicate must read the monotonic counter instead.
  it("keeps a productive op alive past 256 distinct results, where the old size check would have called it dry", () => {
    const op = mkOp("op-long-productive");
    const loop = loopOf(op.id);

    // Replay the OLD predicate alongside, so the test proves the difference
    // rather than asserting the new one in isolation: two consecutive
    // checkpoints with an unchanged seenResultSigs.size.
    let oldLastSize: number | null = null;
    let oldDry = 0;
    const oldPredicateWouldStop = (): boolean => {
      const size = loop.seenResultSigs.size;
      oldDry = oldLastSize !== null && size === oldLastSize ? oldDry + 1 : 0;
      oldLastSize = size;
      return oldDry >= 2;
    };

    learn(op.id, 120);
    expect(oldPredicateWouldStop()).toBe(false);
    expect(evaluateCheckpointStop(op).stop).toBe(false);

    learn(op.id, 150); // 270 distinct so far — past the cap
    expect(loop.seenResultSigs.size).toBe(RESULT_SIG_MEMORY);
    expect(oldPredicateWouldStop()).toBe(false);
    expect(evaluateCheckpointStop(op).stop).toBe(false);

    learn(op.id, 40); // 310 distinct — still learning every turn
    expect(loop.seenResultSigs.size).toBe(RESULT_SIG_MEMORY); // flat
    expect(oldPredicateWouldStop()).toBe(false); // old: dry once
    expect(evaluateCheckpointStop(op).stop).toBe(false);

    learn(op.id, 40); // 350 distinct — STILL learning
    expect(loop.seenResultSigs.size).toBe(RESULT_SIG_MEMORY); // flat again
    // The lie: the old check now calls a productive op dry and stops it.
    expect(oldPredicateWouldStop()).toBe(true);
    // The truth: the counter moved 310 -> 350, so the op keeps going.
    expect(loop.novelResultsTotal).toBe(350);
    expect(evaluateCheckpointStop(op)).toMatchObject({ stop: false, reason: null });

    // And it can STILL stop honestly once the op actually goes dry.
    repeat(op.id, 3);
    expect(evaluateCheckpointStop(op).stop).toBe(false);
    repeat(op.id, 3);
    expect(evaluateCheckpointStop(op)).toMatchObject({ stop: true, reason: "dry-checkpoints" });
  });
});

describe("evaluateCheckpointStop — spend ceiling", () => {
  it("stops an API-key op when real spend has reached the session budget", () => {
    setBudgets(0, 5);
    spend6Usd("env");
    const op = mkOp("op-spend-session", "env");
    learn(op.id, 1);
    const d = evaluateCheckpointStop(op);
    expect(d).toMatchObject({ stop: true, reason: "spend-ceiling" });
    expect(d.detail).toContain("session");
  });

  it("stops an API-key op when real spend has reached the daily budget", () => {
    setBudgets(5, 0);
    spend6Usd("env", "some-other-session"); // daily is cross-session
    const op = mkOp("op-spend-daily", "env");
    learn(op.id, 1);
    const d = evaluateCheckpointStop(op);
    expect(d).toMatchObject({ stop: true, reason: "spend-ceiling" });
    expect(d.detail).toContain("daily");
  });

  it("reports the daily reason when both budgets are tripped", () => {
    setBudgets(5, 5);
    spend6Usd("env");
    const op = mkOp("op-spend-both", "env");
    learn(op.id, 1);
    expect(evaluateCheckpointStop(op).detail).toContain("daily");
  });

  it("continues while spend is under both budgets", () => {
    setBudgets(10, 10);
    spend6Usd("env");
    const op = mkOp("op-under", "env");
    learn(op.id, 1);
    expect(evaluateCheckpointStop(op)).toMatchObject({ stop: false, reason: null });
  });

  it("is a no-op when the user has explicitly disabled both budgets (0), whatever was spent", () => {
    setBudgets(0, 0);
    spend6Usd("env");
    const op = mkOp("op-nobudget", "env");
    learn(op.id, 1);
    expect(evaluateCheckpointStop(op)).toMatchObject({ stop: false, reason: null });
  });

  // D2. The credential is a PER-OP fact. Two ops in one process, same
  // session, same ledger: the API-key op is stopped, the subscription op is
  // not — and the process-global "last resolved" source is set to the
  // OPPOSITE of each op's own credential, so if the predicate consulted the
  // global instead of the op it would judge both of them wrong.
  it("judges each op on its OWN credential, not the process-global last-resolved source", () => {
    setBudgets(0, 5);
    // Real, billable spend in the shared session — enough to trip the cap.
    spend6Usd("env");

    const apiKeyOp = mkOp("op-api-key", "env");
    const subscriptionOp = mkOp("op-subscription", "oauth");
    learn(apiKeyOp.id, 1);
    learn(subscriptionOp.id, 1);

    noteResolvedAuthSource("oauth"); // global says "subscription" — must not exempt the API-key op
    expect(evaluateCheckpointStop(apiKeyOp)).toMatchObject({ stop: true, reason: "spend-ceiling" });

    noteResolvedAuthSource("env"); // global says "API key" — must not stop the subscription op
    expect(evaluateCheckpointStop(subscriptionOp)).toMatchObject({ stop: false, reason: null });
  });

  it("never stops a subscription op on spend even when its own records carry the shadow cost", () => {
    setBudgets(5, 5);
    spend6Usd("oauth"); // booked as shadow — costUsd stays $0 by construction
    spend6Usd("env");   // AND real billable spend in the same session
    const op = mkOp("op-oauth-own", "oauth");
    learn(op.id, 1);
    expect(evaluateCheckpointStop(op)).toMatchObject({ stop: false, reason: null });
  });
});

describe("spend budgets — schema defaults", () => {
  it("default to $15 per session and $75 per day", () => {
    const cfg = configSchema.parse({});
    expect(cfg.sessionBudgetUsd).toBe(15);
    expect(cfg.dailyBudgetUsd).toBe(75);
  });

  it("an explicit 0 still means disabled", () => {
    const cfg = configSchema.parse({ sessionBudgetUsd: 0, dailyBudgetUsd: 0 });
    expect(cfg.sessionBudgetUsd).toBe(0);
    expect(cfg.dailyBudgetUsd).toBe(0);
  });

  it("bind for a DEFAULT-configured API-key user: $16 of session spend stops the op", () => {
    const defaults = configSchema.parse({});
    setRuntimeConfig({ ...loadConfig(), dailyBudgetUsd: defaults.dailyBudgetUsd, sessionBudgetUsd: defaults.sessionBudgetUsd, modelDailyBudgetsUsd: {} });
    // $15 exactly is the ceiling (>=); $16 is over it.
    trackUsage(SESSION, "claude-opus-4-8", "anthropic", 0, 640_000, undefined, "env");
    const op = mkOp("op-default-user", "env");
    learn(op.id, 1);
    const d = evaluateCheckpointStop(op);
    expect(d).toMatchObject({ stop: true, reason: "spend-ceiling" });
    expect(d.detail).toContain("$15.00");
  });

  it("do NOT bind for a DEFAULT-configured subscription user at the same token volume", () => {
    const defaults = configSchema.parse({});
    setRuntimeConfig({ ...loadConfig(), dailyBudgetUsd: defaults.dailyBudgetUsd, sessionBudgetUsd: defaults.sessionBudgetUsd, modelDailyBudgetsUsd: {} });
    trackUsage(SESSION, "claude-opus-4-8", "anthropic", 0, 640_000, undefined, "oauth");
    const op = mkOp("op-default-sub", "oauth");
    learn(op.id, 1);
    expect(evaluateCheckpointStop(op)).toMatchObject({ stop: false, reason: null });
  });
});
