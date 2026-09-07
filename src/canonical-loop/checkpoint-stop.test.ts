/**
 * Unit coverage for the checkpoint stop predicate.
 *
 * The worker-level behaviour (interactive continues past maxIterations; stops
 * on dry rungs) is proved end-to-end in test/worker-honors-iteration-budget.test.ts
 * against a real worker. This file pins the two conditions that cannot be
 * reached from a fake adapter — the loop-detection nudge ceiling and the USD
 * spend ceiling — plus the subscription carve-out that must NEVER stop a user
 * whose marginal cost is zero.
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
const { getMiddlewareState, _resetMiddlewareStates } = await import("./middlewares/state.js");
const { createLoopState, NUDGE_CEILING } = await import("../agent-guards/loop-detection.js");
const { evaluateCheckpointStop } = await import("./checkpoint-stop.js");
type LoopState = import("../agent-guards/loop-detection.js").LoopState;
type Op = import("../ops/types.js").Op;

const SESSION = "sess-checkpoint-stop";

function mkOp(id: string): Op {
  return {
    id,
    sessionId: SESSION,
    type: "chat_turn",
    task: "checkpoint stop",
    contextPack: { budget: { maxIterations: 160, maxTokens: 0, maxWallTimeMs: 0, maxSelfEditCalls: 0 } } as Op["contextPack"],
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

/** Give the op a fresh, distinct piece of evidence so the dry-checkpoint
 *  condition (which is evaluated first) never fires and masks the condition
 *  under test. */
function addEvidence(opId: string, n: number): void {
  const loop = getMiddlewareState<LoopState>(opId, "loop-detection", createLoopState);
  for (let i = 0; i <= n; i++) loop.seenResultSigs.add(`sig-${opId}-${i}`);
}

beforeEach(() => {
  _resetMiddlewareStates();
  const usageFile = join(tmp, "usage-log.json");
  if (existsSync(usageFile)) unlinkSync(usageFile);
  setBudgets(0, 0);
  noteResolvedAuthSource("env");
});

describe("evaluateCheckpointStop", () => {
  it("continues when evidence keeps growing and nothing else trips", () => {
    const op = mkOp("op-progress");
    addEvidence(op.id, 1);
    expect(evaluateCheckpointStop(op)).toMatchObject({ stop: false, reason: null });
    addEvidence(op.id, 5);
    expect(evaluateCheckpointStop(op)).toMatchObject({ stop: false, reason: null });
    addEvidence(op.id, 9);
    expect(evaluateCheckpointStop(op)).toMatchObject({ stop: false, reason: null });
  });

  it("stops after two consecutive checkpoints that learned nothing", () => {
    const op = mkOp("op-dry");
    addEvidence(op.id, 2);
    // 1st: no prior count to compare against.
    expect(evaluateCheckpointStop(op).stop).toBe(false);
    // 2nd: dry once — one dry rung is not enough.
    expect(evaluateCheckpointStop(op).stop).toBe(false);
    // 3rd: two dry rungs in a row.
    expect(evaluateCheckpointStop(op)).toMatchObject({ stop: true, reason: "dry-checkpoints" });
  });

  it("honors budget-ladder's own dryRungs counter", () => {
    const op = mkOp("op-ladder-dry");
    addEvidence(op.id, 3);
    getMiddlewareState<{ fired: Set<number>; lastEvidenceCount: number | null; dryRungs: number }>(
      op.id, "budget-ladder", () => ({ fired: new Set<number>(), lastEvidenceCount: null, dryRungs: 0 }),
    ).dryRungs = 2;
    expect(evaluateCheckpointStop(op)).toMatchObject({ stop: true, reason: "dry-checkpoints" });
  });

  it("stops once loop-detection has nudged past the ceiling", () => {
    const op = mkOp("op-nudge");
    addEvidence(op.id, 1);
    const loop = getMiddlewareState<LoopState>(op.id, "loop-detection", createLoopState);
    loop.nudgeCount = NUDGE_CEILING; // at the ceiling is still allowed
    addEvidence(op.id, 4);
    expect(evaluateCheckpointStop(op).stop).toBe(false);
    loop.nudgeCount = NUDGE_CEILING + 1;
    addEvidence(op.id, 8);
    expect(evaluateCheckpointStop(op)).toMatchObject({ stop: true, reason: "nudge-ceiling" });
  });

  it("stops when real API spend has reached the session budget", () => {
    setBudgets(0, 5);
    noteResolvedAuthSource("env");
    // $6 of opus output tokens on a real per-token API key.
    trackUsage(SESSION, "claude-opus-4-8", "anthropic", 0, 240_000, undefined, "env");
    const op = mkOp("op-spend");
    addEvidence(op.id, 1);
    const d = evaluateCheckpointStop(op);
    expect(d).toMatchObject({ stop: true, reason: "spend-ceiling" });
    expect(d.detail).toContain("session");
  });

  it("stops when real API spend has reached the daily budget", () => {
    setBudgets(5, 0);
    noteResolvedAuthSource("env");
    trackUsage(SESSION, "claude-opus-4-8", "anthropic", 0, 240_000, undefined, "env");
    const op = mkOp("op-spend-daily");
    addEvidence(op.id, 1);
    expect(evaluateCheckpointStop(op)).toMatchObject({ stop: true, reason: "spend-ceiling" });
  });

  it("never stops a flat-rate subscription op on spend — marginal cost is zero", () => {
    setBudgets(5, 5);
    // Same token volume, but billed to a subscription: the USD figure is a
    // shadow estimate, not money. This is the carve-out spend-cap-pack makes.
    trackUsage(SESSION, "claude-opus-4-8", "anthropic", 0, 240_000, undefined, "oauth");
    noteResolvedAuthSource("oauth");
    const op = mkOp("op-oauth");
    addEvidence(op.id, 1);
    expect(evaluateCheckpointStop(op)).toMatchObject({ stop: false, reason: null });
  });

  it("is a no-op when no budget is configured, whatever was spent", () => {
    setBudgets(0, 0);
    noteResolvedAuthSource("env");
    trackUsage(SESSION, "claude-opus-4-8", "anthropic", 0, 240_000, undefined, "env");
    const op = mkOp("op-nobudget");
    addEvidence(op.id, 1);
    expect(evaluateCheckpointStop(op)).toMatchObject({ stop: false, reason: null });
  });
});
