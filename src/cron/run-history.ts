/**
 * Cron Run History
 *
 * Appends one record per scheduled-mission execution attempt to a per-job
 * JSON Lines file. Supports manual runs, scheduled runs, skipped (overlap)
 * runs, and failures.
 *
 * Storage layout: {dataDir}/cron/history/{jobId}.jsonl
 */

import { existsSync, readFileSync, appendFileSync, writeFileSync, mkdirSync, readdirSync, unlinkSync } from "node:fs";
import { join } from "node:path";

export type CronRunStatus = "success" | "failed" | "error" | "skipped";

export interface CronRunRecord {
  /** Unique run id — `run_{ts_base36}_{rand}` */
  id: string;
  jobId: string;
  jobName: string;
  /** ISO time the schedule tick fired (or when run-now was requested). */
  scheduledAt: string;
  /** ISO time execution actually began. Equal to scheduledAt for skipped runs. */
  startedAt: string;
  /** ISO time execution finished. Present for non-skipped runs. */
  finishedAt?: string;
  durationMs?: number;
  status: CronRunStatus;
  /** True if triggered from run-now / API rather than the timer. */
  manual?: boolean;
  /** First N chars of agent output (capped to keep history file small). */
  outputSummary?: string;
  /** Path to the canonical report file, if one was written. */
  reportPath?: string;
  /** Failure / error / skip reason (single line). */
  errorMessage?: string;
  provider?: string;
  model?: string;
}

/** Hard cap on records kept per job. Older entries are trimmed on append. */
const DEFAULT_LIMIT_PER_JOB = 200;

/** Cap on stored output summary so history files stay tiny. */
export const SUMMARY_MAX_CHARS = 500;

export class RunHistoryStore {
  private dir: string;
  private limit: number;

  constructor(dataDir: string, limit = DEFAULT_LIMIT_PER_JOB) {
    this.dir = join(dataDir, "cron", "history");
    this.limit = limit;
    if (!existsSync(this.dir)) mkdirSync(this.dir, { recursive: true, mode: 0o700 });
  }

  private fileFor(jobId: string): string {
    return join(this.dir, `${jobId}.jsonl`);
  }

  append(record: CronRunRecord): void {
    const file = this.fileFor(record.jobId);
    const line = JSON.stringify(record) + "\n";
    try {
      appendFileSync(file, line, "utf-8");
    } catch {
      return;
    }
    this.maybeTrim(file);
  }

  /** If file exceeds limit lines, rewrite keeping only the most recent `limit`. */
  private maybeTrim(file: string): void {
    try {
      const raw = readFileSync(file, "utf-8");
      const lines = raw.split("\n").filter(l => l.length > 0);
      if (lines.length <= this.limit) return;
      const kept = lines.slice(-this.limit);
      writeFileSync(file, kept.join("\n") + "\n", "utf-8");
    } catch { /* ignore */ }
  }

  /** Return up to `limit` most recent runs for `jobId`, newest first. */
  list(jobId: string, limit = 50): CronRunRecord[] {
    const file = this.fileFor(jobId);
    if (!existsSync(file)) return [];
    let raw: string;
    try { raw = readFileSync(file, "utf-8"); } catch { return []; }
    const lines = raw.split("\n").filter(l => l.length > 0);
    const tail = lines.slice(-limit);
    const out: CronRunRecord[] = [];
    for (const l of tail) {
      try { out.push(JSON.parse(l)); } catch { /* skip corrupt line */ }
    }
    return out.reverse();
  }

  /** Most recent N records across all jobs, newest first. */
  recent(limit = 50): CronRunRecord[] {
    if (!existsSync(this.dir)) return [];
    const all: CronRunRecord[] = [];
    for (const f of readdirSync(this.dir)) {
      if (!f.endsWith(".jsonl")) continue;
      const jobId = f.slice(0, -".jsonl".length);
      all.push(...this.list(jobId, limit));
    }
    all.sort((a, b) => (a.startedAt < b.startedAt ? 1 : -1));
    return all.slice(0, limit);
  }

  /** Remove all history for a job (e.g., on job delete). */
  purge(jobId: string): void {
    const file = this.fileFor(jobId);
    if (!existsSync(file)) return;
    try { unlinkSync(file); } catch { /* ignore */ }
  }
}

/** Generate a compact, sortable run id. */
export function newRunId(): string {
  return `run_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

/** Truncate an output snippet for safe storage in history. */
export function summarize(output: string, max = SUMMARY_MAX_CHARS): string {
  if (!output) return "";
  const trimmed = output.trim();
  if (trimmed.length <= max) return trimmed;
  return trimmed.slice(0, max - 1) + "…";
}
