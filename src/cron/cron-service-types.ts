/**
 * Cron service — types, constants, pure helpers.
 *
 * Split out of cron-service.ts so the orchestrator stays under the
 * 400-LOC file limit. Execution + retry state machine lives in
 * cron-service-execute.ts.
 */

import type { CronRunStatus } from "./run-history.js";

export interface CronJob {
  id: string;
  name: string;
  schedule: string; // cron expression or interval like "5m", "1h"
  prompt: string;
  enabled: boolean;
  systemJob?: boolean;
  /** Per-job model selection. When both `provider` and `model` are set,
   *  the executor uses them as overrides instead of the system defaults.
   *  Empty string or undefined means "system default" (resolved at run
   *  time from settings.json + the legacy anthropic→sonnet-4-6 pin). */
  provider?: string;
  model?: string;
  lastRun?: string;
  lastResult?: string;
  lastReportPath?: string;
  lastStatus?: CronRunStatus;
  lastErrorMessage?: string;
  consecutiveFailures?: number;
  lastSuccessAt?: string;
  createdAt: string;
}

export interface CronSettings {
  enabled: boolean;
  maxConcurrent: number;
  /** Auto-pause job after this many consecutive failures (0 = never auto-pause). */
  maxConsecutiveFailures: number;
  /** Bounded retries on transient (thrown) failures, per scheduled tick. */
  maxTransientRetries: number;
}

export interface ExecuteResult {
  output: string;
  reportPath?: string;
  /** Optional explicit status hint from the executor. */
  status?: CronRunStatus;
  errorMessage?: string;
  provider?: string;
  model?: string;
}

export interface ExecuteContext {
  scheduledAt: string;
  manual: boolean;
}

export type ExecuteHandler = (
  jobId: string,
  prompt: string,
  ctx: ExecuteContext,
) => Promise<string | ExecuteResult>;

export const DEFAULT_SETTINGS: CronSettings = {
  enabled: true,
  maxConcurrent: 3,
  maxConsecutiveFailures: 5,
  maxTransientRetries: 2,
};

export const TRANSIENT_BACKOFF_MS = [60_000, 180_000];

export function classifyStatus(result: ExecuteResult): CronRunStatus {
  if (result.status) return result.status;
  const head = (result.output || "").trim().slice(0, 16).toUpperCase();
  if (head.startsWith("FAILED:")) return "failed";
  if (head.startsWith("ERROR:")) return "error";
  return "success";
}

export function extractErrorMessage(output: string): string | undefined {
  const trimmed = (output || "").trim();
  if (!trimmed) return undefined;
  const firstLine = trimmed.split("\n")[0].trim();
  return firstLine.length > 240 ? firstLine.slice(0, 240) + "…" : firstLine;
}
