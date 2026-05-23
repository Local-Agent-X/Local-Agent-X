import type { TransitionReport } from "../archive.js";

export interface CuratorState {
  lastRunTs: number;
  lastReportPath: string;
  runs: number;
}

export interface Cluster {
  members: string[];
  /** Highest pairwise similarity inside the cluster (sanity check). */
  cohesion: number;
}

export interface CuratorReport {
  ts: number;
  transitions: TransitionReport;
  clusters: Cluster[];
  searchMisses: Array<{ query: string; count: number; daysAgo: number }>;
  llmJudgments: {
    consolidations: string;
    catalogGaps: string;
    skipped?: string;
  };
  reportPath: string;
}

export interface RunCuratorOpts {
  /** Skip lifecycle transitions (dry-mode for transitions only). Default false. */
  skipTransitions?: boolean;
  /** Override the stale→archive cutoff. Default 90 days. */
  archiveAfterDays?: number;
  /** Override the archive→purge cutoff. Default 30 days. */
  purgeArchivedAfterDays?: number;
  /** Min cosine similarity for cluster detection. Default 0.78. */
  clusterThreshold?: number;
}

export interface LLMInput {
  clusters: Cluster[];
  protocolsByName: Record<string, { name: string; description: string; triggers: string[] }>;
  searchMisses: Array<{ query: string; count: number }>;
}

export interface LLMJudgment {
  consolidations: string;
  catalogGaps: string;
  skipped?: string;
}

export interface EmbeddingCacheEntry { vec: number[]; textHash: string }
export type EmbeddingCache = Record<string, EmbeddingCacheEntry>;
