/**
 * Regression — the worker must honor `contextPack.budget.maxTokens` (C4), and
 * every `turn_committed` event must carry the op's running token total.
 *
 * Two mechanisms, backend only:
 *
 *  (1) ENFORCEMENT, as a STOP. This test drives an op whose every turn is a
 *      non-terminal tool call carrying usage tokens, with a maxTokens budget
 *      that the SECOND turn's cumulative total crosses. The worker must stop
 *      after exactly 2 turns and finalize the op `succeeded / partial` with an
 *      `iteration_checkpoint` naming reason `token-ceiling`. maxIterations is
 *      set high (10) so the turn cap can't be what stops it.
 *
 *      It used to finalize `failed / aborted` with a `max_tokens_exceeded`
 *      error, which discarded every turn the op had already paid for and told
 *      every reporting surface the work was worthless. Live case 2026-09-22: a
 *      verification pass spent 85,419 of its 80,000 tokens over eight turns and
 *      reported `failed` with no verdict. The meter is cumulative — each turn
 *      re-sends the transcript and is billed for it — so reaching a ceiling is
 *      an ORDINARY way for a multi-turn op to end, not a fault.
 *
 *      Dormancy: the mechanism stays inert when maxTokens is unset/0 — proven by
 *      test (2), whose op runs to natural completion with maxTokens: 0 despite
 *      accumulating tokens well past any accidental threshold.
 *
 *  (2) RUNNING TOTAL. Each `turn_committed` event carries `usage.totalTokens`,
 *      the sum across all persisted op_turns AT that commit — so a UI meter can
 *      watch cost climb. This test runs two token-bearing turns and asserts the
 *      per-turn totals accumulate (turn 0 → 600, turn 1 → 1200).
 *
 * Real seam exercised: a genuine worker drives a real adapter against a live tool
 * dispatcher; usage tokens flow through providerState → persisted op_turn →
 * aggregateOpUsage, exactly as production does.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { existsSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import {
  canonicalLoopEntry,
  registerAdapterForOp,
  resetCanonicalRuntime,
  resetScheduler,
  awaitIdle,
  resetBus,
  setLeaseConfig,
  resetLeaseConfig,
  setToolDispatcher,
  readCanonicalEvents,
} from "../src/canonical-loop/index.js";
import { resolveTerminalOpStatus } from "../src/canonical-loop/checkpoint-stop.js";
import { readOpTurns } from "../src/canonical-loop/store.js";
import { readOp, newOpId } from "../src/ops/op-store.js";
import type { Op } from "../src/ops/types.js";

import { FakeAdapter, scriptTurn } from "./canonical-loop/fake-adapter.js";

const OPS_BASE = join(homedir(), ".lax", "operations");
const tracked: string[] = [];
const track = <T extends string>(id: T): T => { tracked.push(id); return id; };

// Each token-bearing turn contributes this much usage.
const IN_PER_TURN = 400;
const OUT_PER_TURN = 200;
const PER_TURN = IN_PER_TURN + OUT_PER_TURN; // 600

beforeEach(() => {
  process.env.LAX_CANONICAL_LOOP_INTERACTIVE = "1";
  setLeaseConfig({ leaseDurationMs: 100, heartbeatIntervalMs: 25 });
});

afterEach(async () => {
  await awaitIdle(3_000).catch(() => undefined);
  resetScheduler();
  resetCanonicalRuntime();
  resetBus();
  resetLeaseConfig();
  for (const id of tracked) {
    const dir = join(OPS_BASE, id);
    if (existsSync(dir)) {
      try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
    }
  }
  tracked.length = 0;
  delete process.env.LAX_CANONICAL_LOOP_INTERACTIVE;
});

function mkOp(budget: { maxIterations: number; maxTokens: number }): Op {
  return {
    id: track(newOpId("tokbudget")),
    type: "freeform",
    task: "token-budget cap",
    contextPack: {
      budget: {
        maxIterations: budget.maxIterations,
        maxTokens: budget.maxTokens,
        maxWallTimeMs: 0,
        maxSelfEditCalls: 0,
      },
    } as Op["contextPack"],
    lane: "interactive",
    retryPolicy: { maxRecoveryAttempts: 3, backoffMs: [5_000] },
    ownerId: "test-token-budget",
    visibility: "private",
    status: "pending",
    createdAt: new Date().toISOString(),
    attemptCount: 0,
  };
}

// A benign dispatcher so each non-terminal tool turn commits and the loop advances.
function benignDispatcher() {
  setToolDispatcher({
    async dispatch(call) {
      return { toolCallId: call.toolCallId, status: "ok", result: { ok: true }, durationMs: 0 };
    },
  });
}

async function awaitTerminal(opId: string, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const s = readOp(opId)?.canonical?.state;
    if (s === "succeeded" || s === "failed" || s === "cancelled") return;
    if (Date.now() > deadline) return;
    await new Promise(r => setTimeout(r, 5));
  }
}

describe("worker honors budget.maxTokens (C4)", () => {
  it("caps the drive loop when cumulative tokens meet/exceed maxTokens → succeeded/partial + token-ceiling", async () => {
    // Budget of 1000: turn 0 lands 600 (< 1000, continue), turn 1 lands 1200
    // (>= 1000, trip). maxIterations 10 so the iteration cap can't fire first.
    const op = mkOp({ maxIterations: 10, maxTokens: 1000 });

    // Every turn: a non-terminal, non-silent tool call (terminalReason stays
    // null so the loop never ends on its own) carrying PER_TURN usage tokens.
    const script = Array.from({ length: 10 }, (_, i) =>
      scriptTurn({
        toolCalls: [{ toolCallId: `tok-tc-${i}`, tool: "search", args: {} }],
        providerStatePayload: { usageInputTokens: IN_PER_TURN, usageOutputTokens: OUT_PER_TURN },
      }),
    );
    const fake = new FakeAdapter({ script });
    registerAdapterForOp(op.id, () => fake);
    benignDispatcher();

    canonicalLoopEntry(op);
    await awaitTerminal(op.id);
    await awaitIdle(5_000).catch(() => undefined);

    const after = readOp(op.id);

    // The op tripped the token ceiling and STOPPED — it did NOT run the full
    // 10-turn script to a natural completion, and it did not fail.
    expect(after?.canonical?.state).toBe("succeeded");

    // Exactly 2 driveTurn calls: turn 0 (600 total, under) then turn 1 (1200
    // total, trips the cap after commit, before a 3rd turn).
    expect(fake.turnInputs.length).toBe(2);

    // No error event: a spent budget is not a fault, and an error here is what
    // made the AGENTS card read "failed" with nothing to show for the spend.
    const events = readCanonicalEvents(op.id);
    expect(events.find(e => e.type === "error")).toBeUndefined();

    // The stop rides the checkpoint record every partial surface reads.
    const stop = events.find(e =>
      e.type === "iteration_checkpoint" &&
      (e.body as { continuing?: boolean } | undefined)?.continuing === false,
    );
    expect(stop).toBeDefined();
    const body = stop!.body as { stopReason?: string; stopDetail?: string; completedTurns?: number };
    expect(body.stopReason).toBe("token-ceiling");
    expect(body.stopDetail).toContain(`${2 * PER_TURN} of 1000`);

    // And the surfaces render it as PARTIAL, not completed — the whole point
    // of the stop is that the work is kept and reported honestly.
    const resolved = resolveTerminalOpStatus(op.id, "succeeded");
    expect(resolved.status).toBe("partial");
    expect(resolved.partialSummary).toContain("token-ceiling");

    // The work survives: both committed turns are still on disk.
    expect(readOpTurns(op.id).length).toBe(2);
  });

  it("stays dormant when maxTokens is 0 (op runs to natural completion) and every turn_committed carries the running total", async () => {
    // maxTokens: 0 → enforcement never fires even as tokens accumulate to 1200.
    const op = mkOp({ maxIterations: 10, maxTokens: 0 });

    // Turn 0: non-terminal tool call (600). Turn 1: terminal done (600). Running
    // total should read 600 then 1200 across the two turn_committed events.
    const script = [
      scriptTurn({
        toolCalls: [{ toolCallId: "u-0", tool: "search", args: {} }],
        providerStatePayload: { usageInputTokens: IN_PER_TURN, usageOutputTokens: OUT_PER_TURN },
      }),
      scriptTurn({
        text: "done",
        terminal: "done",
        providerStatePayload: { usageInputTokens: IN_PER_TURN, usageOutputTokens: OUT_PER_TURN },
      }),
    ];
    const fake = new FakeAdapter({ script });
    registerAdapterForOp(op.id, () => fake);
    benignDispatcher();

    canonicalLoopEntry(op);
    await awaitTerminal(op.id);
    await awaitIdle(5_000).catch(() => undefined);

    const after = readOp(op.id);
    // Dormant maxTokens: the op finished on its own terms, not aborted.
    expect(after?.canonical?.state).toBe("succeeded");

    type CommitBody = { turnIdx: number; usage?: { inputTokens: number; outputTokens: number; totalTokens: number } };
    const commits = readCanonicalEvents(op.id)
      .filter(e => e.type === "turn_committed")
      .map(e => e.body as CommitBody)
      .sort((a, b) => a.turnIdx - b.turnIdx);

    expect(commits.length).toBe(2);

    // Turn 0's commit: only turn 0 persisted → running total = 600.
    expect(commits[0].usage).toBeDefined();
    expect(commits[0].usage!.inputTokens).toBe(IN_PER_TURN);
    expect(commits[0].usage!.outputTokens).toBe(OUT_PER_TURN);
    expect(commits[0].usage!.totalTokens).toBe(PER_TURN);

    // Turn 1's commit: both turns persisted → running total = 1200. Proves the
    // total ACCUMULATES rather than reporting a single turn.
    expect(commits[1].usage!.inputTokens).toBe(2 * IN_PER_TURN);
    expect(commits[1].usage!.outputTokens).toBe(2 * OUT_PER_TURN);
    expect(commits[1].usage!.totalTokens).toBe(2 * PER_TURN);
  });
});
