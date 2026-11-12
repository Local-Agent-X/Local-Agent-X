/**
 * Recurring problems: tool calls that failed the same way in several chats.
 *
 * Inside one run the loop already notices a failure it has met before
 * (canonical-loop/turn-loop/constraint-ledger.ts). Nothing carried that from
 * one chat to the next: the same call could fail the same way every day and
 * each chat met it new. This counts them. It reads the failures the tool-usage
 * log identified (tool-execution/failure-record.ts), groups them by signature,
 * and says which groups are worth a person's or a review's attention.
 *
 * No model is involved: the count is arithmetic over the log. A pattern is
 * "recurring" on evidence alone — several chats, more than one day, and seen
 * recently. The last part is what retires a failure that was fixed: runs carry
 * no app version, so "it stopped happening" is the only signal there is.
 *
 * Pure: the caller reads the log and supplies the clock.
 */
import type { ToolFailureEvent } from "../../tool-execution/tool-usage-telemetry.js";
import { isExcludedFromFailureCounts } from "../../memory/synthetic-sessions.js";

const DAY_MS = 24 * 60 * 60 * 1000;

/** How far back failures are counted. */
export const FAILURE_WINDOW_DAYS = 14;
/** Chats a failure must appear in. One chat is an incident, two a coincidence. */
export const RECURRING_MIN_SESSIONS = 3;
/** Calendar days it must appear on: three chats in one bad afternoon (a site
 *  that was down, a file that was missing) is still one incident. */
export const RECURRING_MIN_DAYS = 2;
/** It must have happened this recently to still be a problem. */
export const RECURRING_FRESH_DAYS = 3;
/** Full records kept per pattern for a later review, newest first, one per chat. */
const MAX_SAMPLES = 6;

export interface FailureSample {
  sessionId: string;
  at: number;
  opId: string;
  toolCallId?: string;
}

export interface FailurePattern {
  signature: string;
  tool: string;
  action?: string;
  status: string;
  layer?: string;
  /** The failure's first line, from its most recent occurrence. */
  reason: string;
  /** Failed calls in the window. */
  count: number;
  /** Distinct chats they happened in. */
  sessions: number;
  /** Distinct calendar days they happened on. */
  days: number;
  firstSeen: number;
  lastSeen: number;
  samples: FailureSample[];
}

/** The local calendar day of a time: what a person means by "on two days". */
function dayKey(at: number): string {
  const d = new Date(at);
  return `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`;
}

/** Group the window's failures by signature, most widespread first. */
export function clusterToolFailures(events: readonly ToolFailureEvent[], now: number): FailurePattern[] {
  const since = now - FAILURE_WINDOW_DAYS * DAY_MS;
  const groups = new Map<string, ToolFailureEvent[]>();
  for (const event of events) {
    if (event.at < since || event.at > now) continue;
    // A failure with no chat cannot be counted across chats.
    if (!event.sessionId || isExcludedFromFailureCounts(event.sessionId)) continue;
    const group = groups.get(event.failure.signature);
    if (group) group.push(event);
    else groups.set(event.failure.signature, [event]);
  }
  const patterns = [...groups.values()].map(patternOf);
  return patterns.sort((a, b) => b.sessions - a.sessions || b.lastSeen - a.lastSeen);
}

function patternOf(group: ToolFailureEvent[]): FailurePattern {
  const newestFirst = [...group].sort((a, b) => b.at - a.at);
  const latest = newestFirst[0];
  const samples: FailureSample[] = [];
  const sampled = new Set<string>();
  for (const event of newestFirst) {
    const sessionId = event.sessionId!;
    if (samples.length >= MAX_SAMPLES || sampled.has(sessionId) || !event.failure.opId) continue;
    sampled.add(sessionId);
    samples.push({
      sessionId, at: event.at, opId: event.failure.opId,
      ...(event.failure.toolCallId ? { toolCallId: event.failure.toolCallId } : {}),
    });
  }
  return {
    signature: latest.failure.signature,
    tool: latest.tool,
    ...(latest.action ? { action: latest.action } : {}),
    status: latest.status,
    ...(latest.failure.layer ? { layer: latest.failure.layer } : {}),
    reason: latest.failure.reason,
    count: group.length,
    sessions: new Set(group.map((e) => e.sessionId)).size,
    days: new Set(group.map((e) => dayKey(e.at))).size,
    firstSeen: newestFirst[newestFirst.length - 1].at,
    lastSeen: latest.at,
    samples,
  };
}

/** Enough chats, on enough days, and still happening. */
export function isRecurring(pattern: FailurePattern, now: number): boolean {
  return pattern.sessions >= RECURRING_MIN_SESSIONS
    && pattern.days >= RECURRING_MIN_DAYS
    && now - pattern.lastSeen <= RECURRING_FRESH_DAYS * DAY_MS;
}

/** The window's recurring problems, most widespread first. */
export function recurringFailures(events: readonly ToolFailureEvent[], now: number): FailurePattern[] {
  return clusterToolFailures(events, now).filter((p) => isRecurring(p, now));
}

/** The earliest time a failure can still count, for the log read. */
export function failureWindowStart(now: number): number {
  return now - FAILURE_WINDOW_DAYS * DAY_MS;
}
