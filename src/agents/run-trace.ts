// Per-run activity trace. AgentRunStore only retains toolsUsed: string[];
// this writes a step-by-step JSONL alongside it so a finished run is
// inspectable after the fact.
//
// Storage: one file per run at ~/.lax/run-traces/<runId>.jsonl, append-only.
// Single writer per runId (the canonical-loop driver); no cross-process lock.
//
// TODO retention/GC: traces accumulate forever today. Add a policy later
// (cap by count + age, parallel to AgentRunStore.clearAll).

import { existsSync, mkdirSync, appendFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { createLogger } from "../logger.js";

const logger = createLogger("agents.run-trace");

export const TRACES_DIR = join(homedir(), ".lax", "run-traces");

const DEFAULT_MAX_FIELD_BYTES = 2048;

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
