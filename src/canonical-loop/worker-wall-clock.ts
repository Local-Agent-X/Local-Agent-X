/**
 * Wall-clock deadline for a worker — armed on EVERY lane from the op's own
 * `contextPack.budget.maxWallTimeMs`, and the ONE place that decides how an
 * op ends when it fires.
 *
 * Until this existed the timer was armed for `interactive` only. A build or
 * background worker in a livelock the cycle detector cannot see (period > 8,
 * jittered laps, one trivially novel result per lap) reads as productive to
 * every other brake — the dry checkpoint sees fresh evidence, the pivot
 * ceiling only counts cycle-armed pivots — and ran 700+ turns unbounded on a
 * subscription login where the spend ceiling never binds. maxWallTimeMs was
 * stamped on those ops (15 min default, ops/tools/shared.ts) and enforced
 * nowhere.
 *
 * A TIMER CANNOT BE THE ENFORCEMENT, which is why `armWallClock` is only half
 * of this module. A turn whose every await settles as a microtask — local
 * tools, synchronous op-store writes, no provider socket — never hands
 * control back to the macrotask phase, so no setTimeout in the process can
 * fire for as long as the worker keeps turning. Measured: a real worker on a
 * scripted local-tool livelock with a 300ms budget armed held one core at
 * 99% for over nine minutes without its own 300ms timer ever running (the
 * lease heartbeat logs "event-loop starvation" while it happens). The
 * starving loop IS the livelock case, so the deadline is read off the clock
 * synchronously at the worker's turn boundary; the armed timer stays as the
 * mid-turn preempt for a single long streaming turn, which is what the
 * interactive lane has always relied on.
 *
 * How the op ends:
 *   - interactive: unchanged — `failed / deadline_exceeded` with the `error`
 *     event the chat event pump renders as "ran for 2h; work saved; say
 *     continue" (chat-runner/event-pump.ts). learned-effectiveness and the
 *     soak metrics pin that mapping.
 *   - every other lane: the way a checkpoint stop ends — an
 *     `iteration_checkpoint { continuing: false, stopReason: "wall-clock" }`
 *     record and `succeeded / iteration_checkpoint` with learnedOutcome
 *     `partial`. ONE record type (checkpoint-stop.ts), so every partial
 *     reader — op_wait, the session observer, the phone projection — renders
 *     the PARTIAL line for it unchanged. Not `failed`: the work up to the
 *     last committed turn is saved and correct; only the budget ran out.
 */
import { emit } from "./event-emitter.js";
import { transitionOp } from "./state-machine.js";
import { recordTerminalOutcome } from "./turn-loop/record-outcome.js";
import type { Op } from "../ops/types.js";
import type { Adapter } from "./adapter-contract.js";
import { getToolTimeout } from "../tool-execution/tool-timeout.js";

/** A positive, finite budget arms the timer; 0 / undefined never fires
 *  (tools/build-app.ts stamps 0 on purpose). */
export function wallClockBudgetMs(op: Op): number | null {
  const ms = op.contextPack?.budget?.maxWallTimeMs;
  return typeof ms === "number" && Number.isFinite(ms) && ms > 0 ? ms : null;
}

/**
 * Time an op has spent inside a tool that may run for as long as it needs (a
 * policy row with `timeoutMs: 0`: waiting on a build, a delegated op, a
 * sub-agent). That is the op waiting on other work, not the op turning, so it
 * is not spent from the wall clock: a lead that drives a build from one turn
 * (build_next) waits for hours, and the deadline is there for a turn that spins.
 */
const unboundedWaits = new Map<string, { doneMs: number; since: number | null }>();

export function unboundedToolMs(opId: string, now = Date.now()): number {
  const w = unboundedWaits.get(opId);
  return w ? w.doneMs + (w.since === null ? 0 : now - w.since) : 0;
}

/** Run a turn's tool calls, counting the time as a wait when one of them is unbounded. */
export async function timeUnboundedTools<T>(opId: string, calls: ReadonlyArray<{ tool: string }>, dispatch: () => Promise<T>): Promise<T> {
  if (!calls.some((c) => getToolTimeout(c.tool) === 0)) return dispatch();
  const w = unboundedWaits.get(opId) ?? { doneMs: 0, since: null };
  unboundedWaits.set(opId, w);
  const since = Date.now();
  w.since = since;
  try {
    return await dispatch();
  } finally {
    w.doneMs += Date.now() - since;
    w.since = null;
  }
}

/** What the op has spent of its wall clock: the time since it started driving, less its unbounded waits. */
export function wallClockSpentMs(opId: string, drivingSince: number, now = Date.now()): number {
  return now - drivingSince - unboundedToolMs(opId, now);
}

/** The mid-turn preempt: fires once the op has SPENT its budget, so it re-arms
 *  for what is left when part of the time went to an unbounded wait. */
export function armWallClock(
  adapter: Adapter,
  wallClockMs: number,
  onExpiry: () => void,
  clock: { opId: string; drivingSince: number },
): { clear(): void } {
  let timer: ReturnType<typeof setTimeout>;
  const arm = (ms: number): void => {
    timer = setTimeout(() => {
      const left = wallClockMs - wallClockSpentMs(clock.opId, clock.drivingSince);
      if (left > 0) return arm(Math.max(left, 1_000));
      onExpiry();
      void adapter.abort(new Error("deadline-exceeded")).catch(() => undefined);
    }, ms);
  };
  arm(wallClockMs);
  return { clear: () => { clearTimeout(timer); unboundedWaits.delete(clock.opId); } };
}

export interface WallClockExpiry {
  op: Op;
  wallClockMs: number;
  elapsedMs: number;
  /** The cadence the op was running at — quoted on the checkpoint record. */
  maxTurns: number;
  /** Turns committed before the deadline (the in-flight turn was discarded). */
  completedTurns: number;
}

/** End the op for an expired wall clock. Returns the lease release reason. */
export function finishOnWallClock(x: WallClockExpiry): string {
  const { op, wallClockMs, elapsedMs } = x;
  if (op.lane === "interactive") {
    // `message` stays the diagnostic string (logs, the background dock);
    // elapsedMs/maxWallTimeMs let the chat event pump render the human version.
    emit(op.id, "error", {
      code: "deadline_exceeded",
      message: `interactive operation exceeded maxWallTimeMs=${wallClockMs}`,
      retryable: true,
      elapsedMs,
      maxWallTimeMs: wallClockMs,
    });
    recordTerminalOutcome(op, "aborted");
    transitionOp(op, "failed", "deadline_exceeded", { learnedOutcome: "aborted" });
    return "deadline_exceeded";
  }
  emit(op.id, "iteration_checkpoint", {
    maxTurns: x.maxTurns,
    completedTurns: x.completedTurns,
    continuing: false,
    stopReason: "wall-clock",
    stopDetail: `ran for ${Math.round(elapsedMs / 1000)}s against the op's ${Math.round(wallClockMs / 1000)}s wall-clock budget (maxWallTimeMs=${wallClockMs})`,
  });
  recordTerminalOutcome(op, "partial");
  transitionOp(op, "succeeded", "iteration_checkpoint", { learnedOutcome: "partial" });
  return "iteration_checkpoint";
}
