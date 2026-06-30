// Per-run activity trace. AgentRunStore only retains toolsUsed: string[];
// this writes a step-by-step JSONL alongside it so a finished run is
// inspectable after the fact.
//
// Storage: one file per run at ~/.lax/run-traces/<runId>.jsonl, append-only.
// Single writer per runId (the canonical-loop driver); no cross-process lock.
//
// Retention: gcTraces() bounds the directory by count + age so it can't grow
// without limit on a long-lived install (a trace is diagnostic; AgentRunStore
// holds the durable summary). It runs opportunistically at run_start — once
// per run, not per event — mirroring AgentRunStore.clearAll's bound-it intent.
// Best-effort: a GC failure never touches the live run.

import { existsSync, mkdirSync, appendFileSync, readFileSync, readdirSync, statSync, rmSync } from "node:fs";
import { join } from "node:path";
import { getLaxDir } from "../lax-data-dir.js";
import { createLogger } from "../logger.js";

const logger = createLogger("agents.run-trace");

export const TRACES_DIR = join(getLaxDir(), "run-traces");

const DEFAULT_MAX_FIELD_BYTES = 2048;

// Retention bounds. Newest MAX_TRACE_FILES are kept; anything older than
// MAX_TRACE_AGE_MS is dropped regardless of count. Generous on purpose —
// traces are small and useful for post-hoc inspection, this just stops
// unbounded growth on a box that's been running agents for months.
const MAX_TRACE_FILES = 500;
const MAX_TRACE_AGE_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

export type TraceEvent =
  | { type: "run_start"; runId: string; ts: number; role: string; task: string }
  | {
      type: "tool_call_started";
      runId: string;
      ts: number;
      toolCallId: string;
      toolName: string;
      risk: string;
      decision: string;
      args: string;
    }
  | {
      type: "tool_call_completed";
      runId: string;
      ts: number;
      toolCallId: string;
      ok: boolean;
      durationMs: number;
      resultPreview: string;
      error?: string;
    }
  | { type: "run_end"; runId: string; ts: number; status: string; tokensUsed?: number };

export type TraceEventType = TraceEvent["type"];

function ensureTracesDir(): void {
  if (!existsSync(TRACES_DIR)) mkdirSync(TRACES_DIR, { recursive: true });
}

function tracePath(runId: string): string {
  return join(TRACES_DIR, `${runId}.jsonl`);
}

/**
 * Cap a value to ~maxBytes of UTF-16 length, stringified. Strings pass
 * through; everything else goes through JSON.stringify with a circular-safe
 * fallback. Truncation suffix tells the reader bytes were dropped so a
 * UI can flag a "truncated" badge without parsing.
 */
export function capValue(value: unknown, maxBytes = DEFAULT_MAX_FIELD_BYTES): string {
  let s: string;
  if (typeof value === "string") {
    s = value;
  } else {
    try { s = JSON.stringify(value); }
    catch { s = String(value); }
  }
  if (s.length <= maxBytes) return s;
  const dropped = s.length - (maxBytes - 32);
  return s.slice(0, maxBytes - 32) + `… [truncated ${dropped}b]`;
}

export function appendTraceEvent(runId: string, event: TraceEvent): void {
  if (!runId) return;
  try {
    ensureTracesDir();
    appendFileSync(tracePath(runId), JSON.stringify(event) + "\n", "utf-8");
  } catch (e) {
    // A trace write failure must never break the actual run.
    logger.warn(`[trace] append failed for run ${runId}: ${(e as Error).message}`);
  }
  // Sweep old traces once per run (run_start fires exactly once). Done after
  // the append so a GC issue can never cost us the event we just wrote; the
  // run's own fresh file is newest, so it's never a GC candidate.
  if (event.type === "run_start") gcTraces();
}

/**
 * Bound the traces directory: delete files older than `maxAgeMs` and, beyond
 * that, keep only the newest `maxFiles`. Best-effort and self-contained — it
 * never throws, so callers (appendTraceEvent at run_start) don't guard it.
 * Returns the number of trace files removed. `now` is injectable for tests.
 */
export function gcTraces(opts?: { maxFiles?: number; maxAgeMs?: number; now?: number }): number {
  const maxFiles = opts?.maxFiles ?? MAX_TRACE_FILES;
  const maxAgeMs = opts?.maxAgeMs ?? MAX_TRACE_AGE_MS;
  const now = opts?.now ?? Date.now();
  let removed = 0;
  try {
    if (!existsSync(TRACES_DIR)) return 0;
    const files = readdirSync(TRACES_DIR)
      .filter((name) => name.endsWith(".jsonl"))
      .map((name) => {
        const p = join(TRACES_DIR, name);
        try { return { p, mtimeMs: statSync(p).mtimeMs }; }
        catch { return { p, mtimeMs: 0 }; } // raced away mid-scan — treat as oldest
      })
      .sort((a, b) => b.mtimeMs - a.mtimeMs); // newest first

    files.forEach(({ p, mtimeMs }, i) => {
      const tooOld = maxAgeMs > 0 && now - mtimeMs > maxAgeMs;
      const overCount = maxFiles > 0 && i >= maxFiles;
      if (!tooOld && !overCount) return;
      try { rmSync(p, { force: true }); removed++; }
      catch { /* leave it for the next sweep */ }
    });
  } catch (e) {
    logger.warn(`[trace] gc failed: ${(e as Error).message}`);
  }
  return removed;
}

export function readTrace(runId: string): TraceEvent[] {
  const p = tracePath(runId);
  if (!existsSync(p)) return [];
  let raw: string;
  try { raw = readFileSync(p, "utf-8"); }
  catch (e) {
    logger.warn(`[trace] read failed for run ${runId}: ${(e as Error).message}`);
    return [];
  }
  const events: TraceEvent[] = [];
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try { events.push(JSON.parse(trimmed) as TraceEvent); }
    catch { /* skip malformed line, keep the rest */ }
  }
  return events;
}
