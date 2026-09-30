/**
 * Capability gaps: the findings the post-turn review used to mistake for
 * skills. "grep the raw session logs when memory_search misses" is not a
 * procedure to replay, it is a report that a native tool fell short. Those
 * belong in one append-only log the maintainer reads, not in the protocol
 * catalog the agent replays.
 *
 * One JSON object per line under the data dir. Reads tolerate a torn last
 * line because the writer appends without a lock.
 */
import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { getLaxDir } from "../../lax-data-dir.js";

export interface CapabilityGap {
  sessionId: string;
  timestamp: number;
  /** What the agent needed and could not do natively. */
  summary: string;
  /** The tools that were tried and fell short. */
  toolsTried: string[];
  /** The workaround the run used instead, if any. */
  workaround?: string;
}

export const MAX_GAP_SUMMARY_CHARS = 300;
export const MAX_GAP_TOOLS = 12;

export function capabilityGapsPath(): string {
  return join(getLaxDir(), "capability-gaps.jsonl");
}

export function appendCapabilityGap(gap: CapabilityGap): void {
  const path = capabilityGapsPath();
  mkdirSync(dirname(path), { recursive: true });
  appendFileSync(path, `${JSON.stringify(gap)}\n`, "utf8");
}

export function readCapabilityGaps(): CapabilityGap[] {
  let text: string;
  try { text = readFileSync(capabilityGapsPath(), "utf8"); } catch { return []; }
  const gaps: CapabilityGap[] = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try { gaps.push(JSON.parse(line) as CapabilityGap); } catch { /* torn tail line */ }
  }
  return gaps;
}
