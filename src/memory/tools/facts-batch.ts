import type { MemoryIndex } from "../../memory/index.js";
import type { FactKind } from "../types.js";
import { displayContent } from "../utils.js";
import { MAX_FACTS_PER_CALL } from "../fact-split.js";
import { runMemoryGate, MemoryWriteBlocked } from "../write-safely.js";
import type { MemoryPromotionContext } from "../promotion-gate.js";

// Batched `remember` writer (split out of facts.ts for the 400-LOC cap).
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
  status: "saved" | "blocked" | "skipped";
  /** saved: "#id: content"; blocked: the gate's reason; skipped: why nothing landed. */
  detail: string;
}

export function saveFactsBatch(
  memory: MemoryIndex,
  facts: string[],
  contexts: MemoryPromotionContext[],
  opts: { kind?: FactKind; confidence: number; sourceFile: string; target: string },
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
      });
      if (!result.ok) {
        return { fact, status: "skipped" as const, detail: `not saved (${result.error ?? "unknown error"})` };
      }
      const f = result.fact!;
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
