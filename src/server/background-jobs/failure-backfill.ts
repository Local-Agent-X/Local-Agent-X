/**
 * One-time backfill: the failed tool calls of recent past runs, written into
 * the tool-usage log with the signature a live failure now carries.
 *
 * The log only began saying WHICH failure a failed call was when failure
 * signatures shipped; every line before that says "error" and nothing more.
 * Without this the list of recurring problems starts empty and needs days of
 * new failures before it can say anything, while the runs that already hold
 * the answer sit in the op store.
 *
 * Idempotent by construction: a call the log already identifies (by tool-call
 * id) is never written again, so a pass cut short by a restart, or run twice
 * because the done-mark was lost, adds nothing it already added.
 *
 * Old failures do not pollute the count for long: a pattern has to have
 * happened in the last three days to be listed (failure-patterns.ts), and
 * nothing older than the two-week window is read here at all.
 */
import { listRecentOps } from "../../ops/op-store.js";
import { readOpToolFailures, type OpToolFailure } from "../../canonical-loop/public/op-tool-failures.js";
import {
  failureBackfillDone, logToolUsage, markFailureBackfillDone, readToolFailures,
} from "../../tool-execution/tool-usage-telemetry.js";
import { failureWindowStart } from "../../cognition/cross-session-learning/failure-patterns.js";
import { createLogger } from "../../logger.js";

const logger = createLogger("server.background-jobs.failure-backfill");

/** Most recent runs looked at. Two weeks of heavy use is in the hundreds. */
const MAX_OPS = 3000;

interface PastOp { id: string; sessionId?: string; createdAt: string | number }

export interface FailureBackfillDeps {
  done: () => boolean;
  markDone: () => void;
  recentOps: (limit: number) => PastOp[];
  failuresOf: (opId: string) => OpToolFailure[];
  /** Tool-call ids the log already identifies as failures. */
  knownCallIds: (sinceMs: number) => Promise<Set<string>>;
  write: typeof logToolUsage;
  now: () => number;
}

const REAL: FailureBackfillDeps = {
  done: failureBackfillDone,
  markDone: markFailureBackfillDone,
  recentOps: listRecentOps,
  failuresOf: readOpToolFailures,
  knownCallIds: async (sinceMs) => {
    const ids = new Set<string>();
    for (const event of await readToolFailures(sinceMs)) {
      if (event.failure.toolCallId) ids.add(event.failure.toolCallId);
    }
    return ids;
  },
  write: logToolUsage,
  now: Date.now,
};

/** A run's start as a time. At least one writer persists it as a number. */
function startedAt(op: PastOp): number {
  return typeof op.createdAt === "number" ? op.createdAt : Date.parse(String(op.createdAt));
}

export interface FailureBackfillResult { ops: number; written: number }

/** Run the backfill unless it already ran. Null when there was nothing to do. */
export async function backfillToolFailures(deps: FailureBackfillDeps = REAL): Promise<FailureBackfillResult | null> {
  if (deps.done()) return null;
  const since = failureWindowStart(deps.now());
  const known = await deps.knownCallIds(since);
  let ops = 0;
  let written = 0;
  for (const op of deps.recentOps(MAX_OPS)) {
    if (!(startedAt(op) >= since)) continue;
    ops++;
    let failures: OpToolFailure[];
    try { failures = deps.failuresOf(op.id); }
    catch (e) {
      // One unreadable run must not cost the rest of the backfill.
      logger.debug(`[failure-backfill] skipped ${op.id}: ${(e as Error).message}`);
      continue;
    }
    for (const f of failures) {
      if (known.has(f.toolCallId) || f.at < since) continue;
      known.add(f.toolCallId);
      deps.write({
        ts: new Date(f.at).toISOString(),
        tool: f.tool, status: f.status, callContext: "backfill",
        sessionId: op.sessionId ?? op.id,
        ...(f.action ? { action: f.action } : {}),
        failure: {
          signature: f.signature, reason: f.reason, opId: op.id, toolCallId: f.toolCallId,
          ...(f.layer ? { layer: f.layer } : {}),
        },
      });
      written++;
    }
    // Each run is a few synchronous file reads; let the server breathe between them.
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  deps.markDone();
  logger.info(`[failure-backfill] ${written} failed call(s) from ${ops} past run(s) written to the usage log`);
  return { ops, written };
}
