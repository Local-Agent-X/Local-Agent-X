/**
 * op_submit_batch — the fan-out launcher.
 *
 * Takes a list of DISTINCT tasks, runs each as its own parallel op with a
 * bounded worker pool (default concurrency 4 — the locked "start fan-out at 4"
 * policy; clamped to [1,12], where 12 is the global scheduler ceiling), blocks
 * until ALL of them finish, and returns one AGGREGATED result: per-task
 * {task, status, finalSummary, filesChanged, error?} plus an n-succeeded /
 * n-failed / n-total roll-up.
 *
 * Each task reuses the SAME lower-level primitives the sync single-op path
 * (op-submit.ts) uses — buildOpFromArgs → registerAdapterForOp → canonicalLoopEntry
 * → awaitCanonicalOp — called DIRECTLY. This deliberately bypasses
 * op_submit_async's near-dup / live-peer dedup, which would wrongly reject
 * intentional parallel tasks. Every worker's op nests under the same chat-turn
 * parent because buildOpFromArgs stamps parentOpId from the calling session's
 * host op (chunk C1) — we never override that.
 */

import type { ToolDefinition } from "../../types.js";
import {
  awaitCanonicalOp,
  canonicalLoopEntry,
  registerAdapterForOp,
} from "../../canonical-loop/index.js";
import { trackOpForSession } from "../session-bridge.js";
import {
  buildOpFromArgs,
  readSettingsProvider,
  submitParameters,
} from "./shared.js";

const DEFAULT_CONCURRENCY = 4;
const MAX_CONCURRENCY = 12; // global scheduler ceiling (canonical-loop C2)
const PER_OP_TIMEOUT_MS = 30 * 60 * 1000;

interface BatchTaskResult {
  task: string;
  opId: string | null;
  status: string; // "completed" | "failed" | "cancelled" | "needs-input" | "paused" | "timeout" | "invalid"
  finalSummary: string;
  filesChanged: string[];
  error?: string;
  wallMs?: number;
}

/** Clamp the requested concurrency into [1,12], defaulting to 4. */
function clampConcurrency(raw: unknown): number {
  const n = typeof raw === "number" && Number.isFinite(raw) ? Math.floor(raw) : DEFAULT_CONCURRENCY;
  return Math.max(1, Math.min(MAX_CONCURRENCY, n));
}

/**
 * Run ONE task to terminal via the same primitives as op_submit.ts. Never
 * throws — a task-level failure is captured as a BatchTaskResult so a single
 * bad task can't sink the batch.
 */
async function runOneTask(
  rawTask: Record<string, unknown>,
  sessionId: string,
): Promise<BatchTaskResult> {
  const task = String(rawTask?.task ?? "").trim();
  if (!task) {
    return { task, opId: null, status: "invalid", finalSummary: "empty task description", filesChanged: [], error: "task description is required" };
  }
  try {
    const args = { ...rawTask, ...(sessionId ? { _sessionId: sessionId } : {}) };
    const op = await buildOpFromArgs(args);
    if (sessionId) trackOpForSession(op.id, sessionId, task);

    const opProvider = op.contextPack?.routing?.preferredProvider;
    const effectiveProvider = opProvider ?? (await readSettingsProvider());
    if (effectiveProvider === "codex") {
      const { createCodexAdapter } = await import("../../canonical-loop/index.js");
      registerAdapterForOp(op.id, () => createCodexAdapter({ sessionId: sessionId || undefined }));
    }

    const startMs = Date.now();
    canonicalLoopEntry(op, sessionId ? { sessionId } : {});
    const result = await awaitCanonicalOp(op.id, PER_OP_TIMEOUT_MS);
    const wallMs = Date.now() - startMs;

    if (!result) {
      return { task, opId: op.id, status: "timeout", finalSummary: `op ${op.id} did not complete within 30 min`, filesChanged: [], error: "timed out", wallMs };
    }
    return {
      task,
      opId: op.id,
      status: result.status,
      finalSummary: result.finalSummary,
      filesChanged: result.filesChanged,
      ...(result.error ? { error: result.error.message } : {}),
      wallMs,
    };
  } catch (e) {
    return { task, opId: null, status: "failed", finalSummary: "batch worker threw before the op finished", filesChanged: [], error: (e as Error).message };
  }
}

/**
 * Bounded worker pool over a shared index queue: at most `concurrency` tasks
 * in flight at once. Each worker pulls the next index (the synchronous
 * `next++` makes the claim atomic — no two workers can grab the same slot),
 * runs it to terminal, then loops for the next. A settled task (success OR
 * failure) frees the worker to start the next. Results land positionally so
 * the aggregate preserves input order.
 */
async function runPool(
  tasks: Record<string, unknown>[],
  concurrency: number,
  sessionId: string,
): Promise<BatchTaskResult[]> {
  const results: BatchTaskResult[] = new Array(tasks.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    for (;;) {
      const i = next++;
      if (i >= tasks.length) return;
      results[i] = await runOneTask(tasks[i], sessionId);
    }
  };
  const poolSize = Math.min(concurrency, tasks.length);
  await Promise.all(Array.from({ length: poolSize }, () => worker()));
  return results;
}

export const opSubmitBatchTool: ToolDefinition = {
  name: "op_submit_batch",
  description:
    "FAN-OUT LAUNCHER: run a LIST of DISTINCT tasks as parallel ops at once, watch them all, and get back one aggregated result. Use this when you have several INDEPENDENT jobs to do in parallel (e.g. 'research these 5 topics', 'refactor these 4 files', 'check each of these repos') and you want them all done before you answer. Each task is submitted as its own op and driven concurrently with a bounded pool: `concurrency` defaults to 4 and is clamped to [1,12]. The call BLOCKS until every task reaches a terminal state, then returns per-task {task, status, finalSummary, filesChanged, error?} plus a roll-up (n succeeded / n failed / total). A failing task does NOT abort the batch — its error is captured and the rest keep running. Tasks MUST be genuinely distinct — this is not a retry mechanism; do not pass the same task N times. Each task takes the SAME fields as op_submit (task, success_criteria, constraints, context_files, scope_hint, lane, etc.); CONTEXT-RELAY RULE applies per task — a worker sees only its own task string + fields, never the chat thread or its sibling tasks. Prefer op_submit_async for a SINGLE long job; use this only for real parallel fan-out.",
  parameters: {
    type: "object",
    properties: {
      tasks: {
        type: "array",
        items: submitParameters,
        description: "The DISTINCT tasks to run in parallel. Each item takes the same shape as a single op_submit call (task description + optional success_criteria / constraints / context_files / scope_hint / lane / etc.). Must be genuinely different jobs, not repeats.",
      },
      concurrency: {
        type: "number",
        description: "Max ops in flight at once. Default 4 (the standard fan-out width); clamped to [1,12]. The rest queue and start as each running task settles.",
      },
    },
    required: ["tasks"],
  },
  async execute(args) {
    const rawTasks = Array.isArray(args.tasks) ? (args.tasks as Record<string, unknown>[]) : [];
    if (rawTasks.length === 0) {
      return { content: "op_submit_batch requires a non-empty 'tasks' array of distinct tasks.", isError: true };
    }

    const sessionId = String(args._sessionId || "");
    const concurrency = clampConcurrency(args.concurrency);

    const startMs = Date.now();
    const results = await runPool(rawTasks, concurrency, sessionId);
    const wallMs = Date.now() - startMs;

    const succeeded = results.filter(r => r.status === "completed").length;
    const failed = results.length - succeeded;

    const lines = results.map((r, i) => {
      const secs = r.wallMs !== undefined ? ` (${Math.round(r.wallMs / 1000)}s)` : "";
      const id = r.opId ? ` ${r.opId}` : "";
      const head = `  [${r.status}]${id}${secs} — ${r.task.slice(0, 60)}${r.task.length > 60 ? "…" : ""}`;
      const err = r.error ? `\n      error: ${r.error}` : "";
      const files = r.filesChanged.length > 0 ? `\n      files: ${r.filesChanged.slice(0, 5).join(", ")}${r.filesChanged.length > 5 ? "…" : ""}` : "";
      return `${i + 1}.${head}${err}${files}`;
    });

    const summary =
      `Batch: ${succeeded}/${results.length} succeeded, ${failed} failed ` +
      `(${results.length} total, concurrency=${concurrency}) in ${Math.round(wallMs / 1000)}s\n` +
      lines.join("\n");

    return {
      content: summary,
      isError: succeeded === 0,
      metadata: {
        batch: {
          total: results.length,
          succeeded,
          failed,
          concurrency,
          wallMs,
          results,
        },
      },
    };
  },
};
