/**
 * Operational outcome ingestion — phase 4 of the action-ledger work.
 *
 * Folds the agent's OWN failures (from the action ledger) into long-term
 * memory so "last time I tried X it failed" becomes retrievable across
 * sessions, graph-linked through the existing entity_relations table. Runs as
 * a stage of runConsolidation (nightly + memory_consolidate/memory_dream), so
 * it inherits that schedule and keeps memory writes OUT of the canonical loop.
 *
 * SELECTIVE by design (per the anti-noise rule, see
 * project_memory_worker_hardening): only ops that had a tool FAILURE produce a
 * memory, and at most ONE compact fact per failed op. Successes are not
 * ingested — the ledger already carries them for the in-turn digest, and
 * blanket success-logging would pollute retrieval.
 *
 * Idempotent via a watermark file beside the ledgers: each run only ingests
 * entries newer than the last run's max timestamp.
 */
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { actionLogDir, readAllEntriesSince, type ActionLedgerEntry } from "../ops/action-ledger.js";
import type { MemoryIndex } from "./index.js";
import { createLogger } from "../logger.js";

const logger = createLogger("memory.operational-ingest");

const WATERMARK_FILE = ".ingest-state.json";
const TASK_MAX_CHARS = 120;
// Cap failed tools listed in one fact so the line stays a single compact fact
// (the Facts DB rejects multi-fact blobs).
const MAX_TOOLS_PER_FACT = 6;

interface IngestState { lastTs: string }

export interface OperationalIngestResult {
  ingested: number;
  scanned: number;
}

function watermarkPath(): string {
  return join(actionLogDir(), WATERMARK_FILE);
}

function readWatermark(): string {
  try {
    const raw = readFileSync(watermarkPath(), "utf-8");
    return (JSON.parse(raw) as IngestState).lastTs || "";
  } catch {
    return "";
  }
}

function writeWatermark(lastTs: string): void {
  try {
    const dir = actionLogDir();
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
    writeFileSync(watermarkPath(), JSON.stringify({ lastTs } satisfies IngestState), "utf-8");
  } catch (e) {
    logger.warn(`watermark write failed: ${(e as Error).message}`);
  }
}

/**
 * Ingest new operational failures into `memory`. Returns how many facts were
 * written and how many ledger entries were scanned this run.
 */
export function ingestOperationalOutcomes(memory: MemoryIndex): OperationalIngestResult {
  const since = readWatermark();
  const entries = readAllEntriesSince(since);
  if (entries.length === 0) return { ingested: 0, scanned: 0 };

  // One fact per op that had ≥1 failure. Group failures by op, preserving the
  // op's task + a representative timestamp.
  const byOp = new Map<string, { task: string; date: string; opType: string; tools: Set<string> }>();
  for (const e of entries) {
    const failed = e.actions.filter(a => a.status === "error").map(a => a.tool);
    if (failed.length === 0) continue;
    let g = byOp.get(e.opId);
    if (!g) {
      g = { task: e.task ?? "", date: e.ts.slice(0, 10), opType: e.opType, tools: new Set() };
      byOp.set(e.opId, g);
    }
    for (const t of failed) g.tools.add(t);
  }

  let ingested = 0;
  for (const g of byOp.values()) {
    const tools = [...g.tools].slice(0, MAX_TOOLS_PER_FACT);
    const content = composeFailureFact(g.task, tools, g.date);
    const res = memory.rememberFact(content, { kind: "experience", confidence: 0.8 });
    if (!res.ok) continue;
    ingested++;
    const factId = res.fact?.id;
    const taskObj = (g.task || "an unspecified task").slice(0, TASK_MAX_CHARS);
    for (const tool of tools) {
      memory.storeRelation({
        subject: tool,
        predicate: "failed-during",
        object: taskObj,
        factId,
        confidence: 0.8,
      });
    }
  }

  // Advance the watermark to the newest entry scanned (failure or not) so we
  // never re-scan this window. entries are sorted oldest→newest.
  writeWatermark(entries[entries.length - 1].ts);
  logger.info(`[operational-ingest] scanned=${entries.length} failedOps=${byOp.size} ingested=${ingested}`);
  return { ingested, scanned: entries.length };
}

/** Compose a single-line failure fact under the Facts DB's blob limits. */
export function composeFailureFact(task: string, failedTools: string[], date: string): string {
  const cleanTask = task.replace(/\s+/g, " ").trim().slice(0, TASK_MAX_CHARS);
  const toolList = failedTools.join(", ");
  const taskPart = cleanTask ? ` while working on "${cleanTask}"` : "";
  return `Tool(s) ${toolList} failed${taskPart} (${date}).`;
}

// Re-exported for the consolidation pipeline's stage wiring.
export type { ActionLedgerEntry };
