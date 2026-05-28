// Types + on-disk path constants for the memory consolidator. Kept here so
// the orchestrator and helper modules import a single source of truth for
// where entity pages and the consolidation log live.

import { join } from "node:path";
import { getLaxDir } from "../../../lax-data-dir.js";

export interface FactEntry {
  content: string;
  entity?: string;
  confidence: number;
  accessCount: number;
  createdAt: number;
}

export interface MergedFact {
  original: FactEntry[];
  merged: string;
  confidence: number;
}

export interface ConsolidationReport {
  mergedCount: number;
  promotedCount: number;
  entityPagesUpdated: number;
  contradictionsFound: number;
  timestamp: number;
}

export interface ConsolidationLogEntry {
  report: ConsolidationReport;
  promotedFacts: string[];
  mergedPairs: Array<{ from: string[]; to: string }>;
}

export const LAX_DIR = getLaxDir();
export const MEMORY_DIR = join(LAX_DIR, "memory");
export const ENTITIES_DIR = join(MEMORY_DIR, "bank", "entities");
export const LOG_PATH = join(LAX_DIR, "consolidation-log.json");
