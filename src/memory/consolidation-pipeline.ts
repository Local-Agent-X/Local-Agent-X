/**
 * Consolidation pipeline — the single entry point for the non-agentic memory
 * consolidation stages, run in dependency order:
 *
 *   1. extract     — LLM pulls structured facts from recent chunks through the
 *                    dedup/contradiction resolver (runExtraction). Opt-in.
 *   2. consolidate — zero-LLM Jaccard merge + entity-page regen over stored
 *                    facts (MemoryConsolidator).
 *   3. reflect     — refresh entity summary pages + opinion confidence.
 *
 * These were previously invoked from three scattered places (memory-bg, the
 * memory_consolidate tool, the memory_dream tool) with overlapping/duplicated
 * wiring. This is now the one place that sequences them. It needs only a
 * MemoryIndex, so tools, routes, and background jobs can all call it.
 *
 * The expensive *agentic* dream (worker agents over raw transcripts) is NOT
 * here — it needs heavy server deps and runs behind the triggerDream() seam in
 * dream.ts. The memory_dream tool runs this pipeline AND triggers that.
 */
import type { MemoryIndex } from "./index.js";
import type { ExtractionOptions, ExtractionResult } from "./extract.js";
import type { ConsolidationReport } from "./cognitive/consolidation/types.js";
import { createLogger } from "../logger.js";

const logger = createLogger("memory.consolidation-pipeline");

export interface ConsolidationOptions {
  /** Present → run the LLM extract stage with these opts. Absent → skip it. */
  extract?: ExtractionOptions;
  /** Run the algorithmic consolidate stage (default true). */
  consolidate?: boolean;
  /** Run reflect (default true / 7 days). A number sets the lookback days. */
  reflect?: boolean | number;
  /** Ingest operational failures from the action ledger (default true; zero-LLM). */
  operational?: boolean;
}

export interface ConsolidationSummary {
  extraction?: ExtractionResult;
  consolidation?: ConsolidationReport;
  reflection?: { entitiesUpdated: string[]; opinionsUpdated: number };
  operational?: { ingested: number; scanned: number };
  elapsedMs: number;
}

/** Run the requested cheap consolidation stages in order over `memory`. */
export async function runConsolidation(
  memory: MemoryIndex,
  opts: ConsolidationOptions = {},
): Promise<ConsolidationSummary> {
  const startedAt = Date.now();
  const summary: ConsolidationSummary = { elapsedMs: 0 };

  if (opts.extract) {
    const { runExtraction } = await import("./extract.js");
    summary.extraction = await runExtraction(memory, opts.extract);
  }

  if (opts.consolidate !== false) {
    const { MemoryConsolidator } = await import("./cognitive/consolidation/index.js");
    summary.consolidation = MemoryConsolidator.getInstance().consolidate();
  }

  if (opts.reflect !== false) {
    const sinceDays = typeof opts.reflect === "number" ? opts.reflect : 7;
    summary.reflection = await memory.reflect(sinceDays);
  }

  if (opts.operational !== false) {
    const { ingestOperationalOutcomes } = await import("./operational-ingest.js");
    summary.operational = ingestOperationalOutcomes(memory);
  }

  summary.elapsedMs = Date.now() - startedAt;
  logger.info(
    `[consolidation] extract=${summary.extraction?.factsExtracted ?? "-"} ` +
    `merged=${summary.consolidation?.mergedCount ?? "-"} ` +
    `reflectEntities=${summary.reflection?.entitiesUpdated.length ?? "-"} ` +
    `opIngested=${summary.operational?.ingested ?? "-"} ` +
    `${summary.elapsedMs}ms`,
  );
  return summary;
}
