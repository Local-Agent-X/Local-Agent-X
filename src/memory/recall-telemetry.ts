/**
 * Memory-recall telemetry sidecar — measure the FREE recall path.
 *
 * Zero behavior change. Pure append-only JSONL at
 * ~/.lax/telemetry/memory-recall.jsonl, so the data survives server
 * restarts by construction. Sibling of
 * src/tool-execution/tool-usage-telemetry.ts, which already captures the
 * SLOW path (memory_search / memory_recall tool calls with durationMs);
 * this file captures the per-turn entity scan in buildContextBlock so the
 * two can be joined per session:
 *   - which entity slugs the scan matched, and how many facts rendered
 *     inline into <known_entities> (vs deduped against <core_memory>)
 *   - zero-match turns, including slugs that word-match the message but
 *     sit past the top-N scan cutoff — the evidence for/against widening
 *     that cutoff before paying for a real matcher
 *
 * Read it with:
 *   jq -s 'map(select(.factsRendered > 0)) | length' ~/.lax/telemetry/memory-recall.jsonl
 *   jq -s '[.[] | .cutoffMisses[]?] | group_by(.) | map({slug: .[0], n: length})' ~/.lax/telemetry/memory-recall.jsonl
 */

import { appendFileSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { getLaxDir } from "../lax-data-dir.js";

export interface MemoryRecallEvent {
  ts: string; // ISO
  sessionId?: string;
  /** Entity slugs the top-N scan matched in this turn's user message. */
  matched: string[];
  /** Fact lines rendered inline into <known_entities> this turn. */
  factsRendered: number;
  /** Facts skipped because <core_memory> already rendered them this turn. */
  factsDeduped: number;
  /** Bytes of the rendered <known_entities> body. */
  bytesInjected: number;
  totalEntities: number;
  scannedEntities: number;
  /** Slugs matching the message but beyond the scan cutoff (recognition misses). */
  cutoffMisses?: string[];
}

/**
 * Log one per-turn recall event. Silent — never throws. The path is
 * resolved per call (not at module load) so LAX_DATA_DIR overrides from
 * tests and isolated boots are honored.
 */
export function logMemoryRecall(event: Omit<MemoryRecallEvent, "ts">): void {
  try {
    const dir = join(getLaxDir(), "telemetry");
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
    const line = JSON.stringify({ ts: new Date().toISOString(), ...event }) + "\n";
    appendFileSync(join(dir, "memory-recall.jsonl"), line);
  } catch { /* telemetry must not break agent flow */ }
}
