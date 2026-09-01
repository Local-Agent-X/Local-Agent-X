// Heap-pressure ceilings for tool dispatch. Two knobs, both bounding the
// server's peak heap during one tool turn:
//
//   shouldRefuseToolCall — refuse to START a tool call once the V8 heap is
//     within LAX_HEAP_GUARD_RATIO (default 0.85) of heap_size_limit, which
//     reflects --max-old-space-size (desktop/src/server-process.ts). Motivated
//     by the 2026-08-30 OOM: the server died at heapUsed 3.9 GB / 4 GB after
//     several 10 s mark-compacts mid-turn, the last straw being a glob whose
//     result had nowhere to go. A refused call gets a normal `blocked` envelope
//     telling the model to finish from what it has. Nothing is thrown or
//     killed; read-only tools count too. Control/terminal tools
//     (HEAP_GUARD_EXEMPT_TOOLS) are never refused.
//
//   maxParallelToolBatch — at most N parallel-safe calls in flight per
//     Promise.all sub-batch (LAX_MAX_PARALLEL_TOOLS, default 8), so a 20-glob
//     turn can't hold 20 result buffers at once.
//
// Env knobs are read through functions rather than load-time constants so a
// test can pin them whatever the runner's environment carries; the parse is a
// short-string Number() per batch — immaterial next to the v8 sample. Pure
// apart from `sampleHeapPressure`, whose v8 source is swappable via
// setHeapStatsForTests so tests never depend on the worker's real heap.

import { getHeapStatistics } from "node:v8";
import type { ToolResult } from "../types.js";
import { blocked } from "../tools/result-helpers.js";

/** The two v8.getHeapStatistics fields the guard reads. */
export interface HeapStats { used_heap_size: number; heap_size_limit: number }

export interface HeapPressure { usedMb: number; limitMb: number; ratio: number }

/** Once-per-turn warn state; the batcher creates one per executeToolCalls run. */
export interface HeapGuardTurn { warned: boolean }

export const DEFAULT_HEAP_GUARD_RATIO = 0.85;
export const DEFAULT_MAX_PARALLEL_TOOL_BATCH = 8;

// Control/terminal tools the guard never refuses. Their results are a few
// bytes, so refusing them frees nothing — and refusing ask_user is actively
// harmful: turn-loop/ask-user-terminal.ts:55 only surfaces a question whose
// resultStatus is "ok", so a refused ask_user cannot end the turn, which is
// exactly the exit the refusal message steers the model toward. Only
// control/termination belongs here — never a read/search/fetch tool, however
// small its typical result.
export const HEAP_GUARD_EXEMPT_TOOLS: ReadonlySet<string> = new Set([
  "ask_user",                                          // terminal: ends the turn with a question
  "agent_escalate",                                    // terminal: hands the run to a human
  "task_create", "task_update",                        // bookkeeping the model must do to stop cleanly
  "session_status",                                    // status readout
  "process_status", "process_list", "process_kill",    // see / stop what is running
  "send_file",                                         // delivers an already-finished artifact
]);

export function isHeapGuardExempt(toolName: string): boolean {
  return HEAP_GUARD_EXEMPT_TOOLS.has(toolName);
}

const MB = 1024 * 1024;

// ratio = used_heap_size / heap_size_limit. used_heap_size counts garbage V8
// has not collected yet, not just live objects: measured peaks run 1.25–1.6×
// the live ratio between collections, so a refusal can fire on a
// heavy-but-healthy heap. That errs in the safe direction (a refusal costs one
// summarize-and-finish turn; an OOM costs the process) and self-corrects on
// the next sample once V8 has collected. The 0.85 default is set with that
// overshoot in mind — do not "fix" it by raising the ratio or by sampling a
// live-only figure that V8 does not expose cheaply.
export function heapPressure(stats: HeapStats = getHeapStatistics()): HeapPressure {
  const ratio = stats.heap_size_limit > 0 ? stats.used_heap_size / stats.heap_size_limit : 0;
  return {
    usedMb: Math.round(stats.used_heap_size / MB),
    limitMb: Math.round(stats.heap_size_limit / MB),
    ratio,
  };
}

// LAX_HEAP_GUARD_RATIO: unset/blank/non-numeric → default; exactly 0 disables
// the guard; anything else clamps to [0.5, 0.99] so a typo can neither make
// the guard fire on an idle server nor wait past the point V8 can still GC.
export function parseHeapGuardRatio(raw: string | undefined): number {
  if (raw === undefined || raw.trim() === "") return DEFAULT_HEAP_GUARD_RATIO;
  const n = Number(raw);
  if (!Number.isFinite(n)) return DEFAULT_HEAP_GUARD_RATIO;
  if (n === 0) return 0;
  return Math.min(0.99, Math.max(0.5, n));
}

// LAX_MAX_PARALLEL_TOOLS: positive integer, else the default width.
export function parseMaxParallelTools(raw: string | undefined): number {
  if (raw === undefined || raw.trim() === "") return DEFAULT_MAX_PARALLEL_TOOL_BATCH;
  const n = Number(raw);
  return Number.isInteger(n) && n >= 1 ? n : DEFAULT_MAX_PARALLEL_TOOL_BATCH;
}

export function heapGuardRatio(): number {
  return parseHeapGuardRatio(process.env.LAX_HEAP_GUARD_RATIO);
}

export function maxParallelToolBatch(): number {
  return parseMaxParallelTools(process.env.LAX_MAX_PARALLEL_TOOLS);
}

export function shouldRefuseToolCall(ratio: number, threshold: number = heapGuardRatio()): boolean {
  if (threshold <= 0) return false;
  return ratio >= threshold;
}

export function newHeapGuardTurn(): HeapGuardTurn {
  return { warned: false };
}

export function heapRefusalMessage(p: HeapPressure): string {
  return `refused: server heap at ${p.usedMb}/${p.limitMb} MB (${Math.round(p.ratio * 100)}%); ` +
    "the previous tool results are too large to hold — summarize what you have, " +
    "avoid re-reading large files, or narrow the query";
}

// The refusal envelope: `blocked` (retrying the identical call hits the same
// guard) with the recovery the model should act on. The guard is call-size
// agnostic — a smaller call is refused just the same — so the recovery steers
// the model to FINISH, not to retry smaller. Rendered by the normal audit path
// so tool_end, telemetry, and the model-facing header all match every other
// pre-dispatch block.
export function heapRefusalResult(p: HeapPressure): ToolResult {
  return blocked(heapRefusalMessage(p), {
    layer: "heap-guard",
    recovery: `No further tool calls will run until server memory frees (heap at ${p.usedMb}/${p.limitMb} MB). ` +
      "Do not retry or switch tools — summarize what you already have and finish the turn; " +
      "if you must ask something, use ask_user.",
    userHint: "The server is nearly out of memory holding this conversation's tool results, so I've stopped " +
      "making tool calls for now — I'll finish from what I already have.",
  });
}

// Test seam: swap the v8 source so guard tests are deterministic. Pass null
// to restore the real getHeapStatistics.
let statsForTests: (() => HeapStats) | null = null;
export function setHeapStatsForTests(source: (() => HeapStats) | null): void {
  statsForTests = source;
}

export function sampleHeapPressure(): HeapPressure {
  return heapPressure(statsForTests ? statsForTests() : getHeapStatistics());
}
