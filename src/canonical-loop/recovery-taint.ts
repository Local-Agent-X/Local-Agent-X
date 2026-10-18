// The session taint a resumed op's reads committed, rebuilt from its rows.
//
// The data-lineage registry (data-lineage/taint.ts) lives in process memory:
// a restart forgets every sensitive read, so an op recovered afterwards ran
// its remaining turns in a session the egress gate believed clean. Each
// delivered sensitive read stamps the pairs it committed on its result's
// metadata (`taint_sources`, tool-execution/sensitive-read-taint.ts), which
// the tool_result row keeps; recovery replays them here. Content-less on
// purpose: the fingerprints are not persisted, so the re-recorded entries
// are unclearable by payload overlap and the session stays blocked until the
// user declassifies — the conservative side of the delivery-point invariant.
import { readOpMessages } from "./store.js";
import { recordSensitiveRead, type TaintSource } from "../data-lineage/index.js";
import type { PersistedTaintSource } from "../tool-execution/sensitive-read-taint.js";
import type { Op } from "../ops/types.js";

const TAINT_SOURCES: ReadonlySet<string> = new Set<TaintSource>(["sensitive_file", "secret", "memory", "web", "user_data"]);

/** The taint pairs persisted on an op's tool_result rows, in row order. */
export function persistedTaintSources(opId: string): PersistedTaintSource[] {
  const out: PersistedTaintSource[] = [];
  for (const row of readOpMessages(opId)) {
    if (row.role !== "tool_result") continue;
    const sources = (row.content as { metadata?: { taint_sources?: unknown } } | null)?.metadata?.taint_sources;
    if (!Array.isArray(sources)) continue;
    for (const s of sources) {
      const source = (s as { source?: unknown })?.source;
      const target = (s as { target?: unknown })?.target;
      if (typeof source === "string" && TAINT_SOURCES.has(source) && typeof target === "string" && target) {
        out.push({ source: source as TaintSource, target });
      }
    }
  }
  return out;
}

/** Re-record a recovered op's taint into its session. Returns how many pairs
 *  were replayed; 0 for an op with no session or no tainted read. */
export function restoreSessionTaintForOp(op: Op): number {
  const sessionId = op.canonical?.sessionId;
  if (!sessionId) return 0;
  const pairs = persistedTaintSources(op.id);
  for (const { source, target } of pairs) recordSensitiveRead(sessionId, source, target);
  return pairs.length;
}
