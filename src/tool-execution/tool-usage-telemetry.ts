/**
 * Tool usage telemetry sidecar — count every dispatched tool call silently.
 *
 * Zero behavior change. Pure append-only JSONL at
 * ~/.lax/telemetry/tool-usage.jsonl so the eager/deferred tool tiering in
 * src/tools/audience-map.ts can be driven by observed usage instead of
 * guesswork:
 *   - which tools actually get called, how often, from which audience
 *   - which action a collapsed family tool (protocol, spreadsheet, …) ran
 *   - how often calls end ok vs error vs blocked
 *
 * A call that failed also says which failure it was (`failure`, built by
 * failure-record.ts), so the same failure in several chats can be counted as
 * one pattern (cognition/cross-session-learning/failure-patterns.ts).
 *
 * Read it with: jq -s 'group_by(.tool) | map({tool: .[0].tool, n: length}) | sort_by(-.n)' ~/.lax/telemetry/tool-usage.jsonl
 */

import { appendFileSync, createReadStream, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { getLaxDir } from "../lax-data-dir.js";

const DIR = join(getLaxDir(), "telemetry");
const FILE = join(DIR, "tool-usage.jsonl");
/** Present once the failures of past runs have been written into the log
 *  (server/background-jobs/failure-backfill.ts). Losing it costs one rescan:
 *  the backfill never writes a call the log already holds. */
const BACKFILL_MARK = join(DIR, "failures-backfilled");

/** Which failure a failed call was. Only a line carrying this is ever counted
 *  as a failure: lines written before it existed say "error" and nothing more. */
export interface ToolFailureFields {
  /** failureSignature() of the fields below (tools/failure-signature.ts). */
  signature: string;
  /** The failure's first line, redacted. */
  reason: string;
  /** The gate that refused a blocked call. */
  layer?: string;
  /** The run and the call, for opening the full record later. */
  opId?: string;
  toolCallId?: string;
}

interface ToolUsageEvent {
  ts: string;                    // ISO
  tool: string;
  /** args.action for one-tool-many-actions families (browser, protocol, office). */
  action?: string;
  status: "ok" | "error" | "blocked" | string;
  durationMs?: number;
  sessionId?: string;
  callContext?: string;
  failure?: ToolFailureFields;
}

/** A logged call that failed, as failure-patterns reads it. */
export interface ToolFailureEvent {
  at: number;
  tool: string;
  action?: string;
  status: string;
  sessionId?: string;
  failure: ToolFailureFields;
}

let _inited = false;
function ensure(): void {
  if (_inited) return;
  try { if (!existsSync(DIR)) mkdirSync(DIR, { recursive: true, mode: 0o700 }); _inited = true; } catch {}
}

/** Log one tool invocation. Silent — never throws. `ts` is for a call that
 *  happened earlier than now (the one-time backfill of past runs). */
export function logToolUsage(event: Omit<ToolUsageEvent, "ts"> & { ts?: string }): void {
  try {
    ensure();
    const { ts, ...rest } = event;
    const line = JSON.stringify({ ts: ts ?? new Date().toISOString(), ...rest }) + "\n";
    appendFileSync(FILE, line);
  } catch { /* telemetry must not break agent flow */ }
}

function failureEventOf(line: string, sinceMs: number): ToolFailureEvent | null {
  // Most lines are successes; skip the parse for them.
  if (!line.includes('"failure"')) return null;
  let row: Partial<ToolUsageEvent>;
  try { row = JSON.parse(line) as Partial<ToolUsageEvent>; } catch { return null; } // a torn last line
  const at = Date.parse(row.ts ?? "");
  const failure = row.failure;
  if (!Number.isFinite(at) || at < sinceMs) return null;
  if (!failure || typeof failure.signature !== "string" || typeof row.tool !== "string") return null;
  return {
    at, tool: row.tool, status: String(row.status ?? "error"), failure,
    ...(typeof row.action === "string" ? { action: row.action } : {}),
    ...(typeof row.sessionId === "string" ? { sessionId: row.sessionId } : {}),
  };
}

/**
 * Every logged failure since `sinceMs`, oldest first. The log is never
 * rotated, so it is read as a stream, one line in memory at a time.
 */
export async function readToolFailures(sinceMs: number, file: string = FILE): Promise<ToolFailureEvent[]> {
  if (!existsSync(file)) return [];
  const out: ToolFailureEvent[] = [];
  const lines = createInterface({ input: createReadStream(file, "utf-8"), crlfDelay: Infinity });
  for await (const line of lines) {
    const event = failureEventOf(line, sinceMs);
    if (event) out.push(event);
  }
  return out;
}

export function failureBackfillDone(): boolean {
  return existsSync(BACKFILL_MARK);
}

export function markFailureBackfillDone(): void {
  try {
    ensure();
    writeFileSync(BACKFILL_MARK, new Date().toISOString());
  } catch { /* a lost mark is a rescan, not an error */ }
}
