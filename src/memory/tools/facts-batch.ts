import type { MemoryIndex } from "../../memory/index.js";
import type { FactKind } from "../types.js";
import { displayContent } from "../utils.js";
import { MAX_FACTS_PER_CALL } from "../fact-split.js";
import { runMemoryGate, MemoryWriteBlocked } from "../write-safely.js";
import type { MemoryPromotionContext } from "../promotion-gate.js";

// Batched `remember` writer (split out of facts.ts).
//
// Every fact goes through the SAME canonical single-fact sink as a lone
// `remember` — per-fact runMemoryGate truth, rememberFact's contradiction
// auto-invalidation, dup detection, and index-failure reporting — using the
// per-fact capabilities derived from the one stamped parent
// (splitBatchPromotionContext in promotion-gate.ts). No multi-line text is
// ever assembled, so there is no bullet document for model-controlled
// content to smuggle extra rows into.

export interface BatchFactResult {
  fact: string;
  status: "saved" | "already" | "blocked" | "skipped";
  /** saved / already: "#id: content" (already: a current fact that said it);
   *  blocked: the gate's reason; skipped: why nothing landed. */
  detail: string;
}

export function saveFactsBatch(
  memory: MemoryIndex,
  facts: string[],
  contexts: MemoryPromotionContext[],
  opts: { kind?: FactKind; confidence: number; sourceFile: string; target: string; sourceMessageId?: string; by?: "agent" | "background" },
): BatchFactResult[] {
  return facts.map((fact, i) => {
    if (i >= MAX_FACTS_PER_CALL) {
      return {
        fact,
        status: "skipped" as const,
        detail: `not saved (over the ${MAX_FACTS_PER_CALL}-facts-per-call cap — save it in a follow-up call if it matters)`,
      };
    }
    try {
      const promotion = contexts[i];
      const gated = runMemoryGate({ content: fact, source: "tool", target: opts.target, promotion });
      const result = memory.rememberFact(gated, {
        kind: opts.kind,
        confidence: opts.confidence,
        sourceFile: opts.sourceFile,
        promotion,
        sourceMessageId: opts.sourceMessageId,
        by: opts.by,
      });
      if (!result.ok) {
        return { fact, status: "skipped" as const, detail: `not saved (${result.error ?? "unknown error"})` };
      }
      const f = result.fact!;
      if (result.alreadySaved) {
        return { fact, status: "already" as const, detail: `#${f.id}: ${displayContent(f).slice(0, 80)}` };
      }
      const indexNote = result.indexFailed
        ? ` (keyword index failed: ${result.indexError ?? "facts_fts insert error"})`
        : "";
      return { fact, status: "saved" as const, detail: `#${f.id}: ${displayContent(f).slice(0, 80)}${indexNote}` };
    } catch (e) {
      if (e instanceof MemoryWriteBlocked) {
        return { fact, status: "blocked" as const, detail: e.reason };
      }
      throw e;
    }
  });
}

/** What a batched `remember` tells the model: how many landed, then each fact
 *  on its own line, so it never claims more than was saved. An error when
 *  none landed and none was already in memory. */
export function batchReport(results: BatchFactResult[], label: string): { content: string; isError: boolean } {
  const savedCount = results.filter((r) => r.status === "saved").length;
  const inMemory = savedCount + results.filter((r) => r.status === "already").length;
  const lines = results.map((r) =>
    r.status === "saved"
      ? `SAVED ${r.detail}`
      : r.status === "already"
        ? `ALREADY SAVED, nothing added: ${r.detail}`
      : r.status === "blocked"
        ? `BLOCKED (${r.detail}): ${r.fact.slice(0, 80)}`
        : `NOT SAVED (${r.detail}): ${r.fact.slice(0, 80)}`,
  );
  return { content: `Remembered ${savedCount}/${results.length} facts [${label}]:\n` + lines.join("\n"), isError: inMemory === 0 };
}
