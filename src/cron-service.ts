/**
 * Cron Service for Local Agent X
 *
 * Runs scheduled jobs (prompts) at defined intervals. Jobs persist to disk so
 * they survive restarts. Each run is recorded in a per-job history file (see
 * `src/cron/run-history.ts`) regardless of whether it succeeded, failed,
 * errored, or was skipped due to overlap with a still-running prior execution.
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync, statSync } from "node:fs";
import { join } from "node:path";
import type { ToolDefinition } from "./types.js";

import { createLogger } from "./logger.js";
import {
  msUntilNextCron,
  msSinceLastCronOccurrence,
  getIntervalMs,
  msUntilNextRun,
} from "./cron/cron-parser.js";
import {
  RunHistoryStore,
  newRunId,
  summarize,
  type CronRunRecord,
  type CronRunStatus,
} from "./cron/run-history.js";
import { createCronTools as _createCronTools } from "./cron/tools.js";

const logger = createLogger("cron-service");

export interface CronJob {
  id: string;
  name: string;
  schedule: string; // cron expression or interval like "5m", "1h"
  prompt: string;
  enabled: boolean;
  systemJob?: boolean;
  lastRun?: string;
  lastResult?: string;
  lastReportPath?: string;
  lastStatus?: CronRunStatus;
  lastErrorMessage?: string;
  consecutiveFailures?: number;
  lastSuccessAt?: string;
  createdAt: string;
}

interface CronSettings {
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

type ExecuteHandler = (
  jobId: string,
  prompt: string,
  ctx: ExecuteContext,
) => Promise<string | ExecuteResult>;

const DEFAULT_SETTINGS: CronSettings = {
  enabled: true,
  maxConcurrent: 3,
  maxConsecutiveFailures: 5,
  maxTransientRetries: 2,
};

const TRANSIENT_BACKOFF_MS = [60_000, 180_000];

export class CronService {
  private jobs: Map<string, CronJob> = new Map();
  private timers: Map<string, ReturnType<typeof setInterval>> = new Map();
  private dataDir: string;
  private jobsFile: string;
  private settingsFile: string;
  private settings: CronSettings = { ...DEFAULT_SETTINGS };
  private executeHandler: ExecuteHandler | null = null;
  private running = new Set<string>();
  private concurrencyDeferCount = new Map<string, number>();
  private transientRetryCount = new Map<string, number>();
  private lastFileMtime = 0;
  private history: RunHistoryStore;

  constructor(dataDir: string) {
    this.dataDir = dataDir;
    const cronDir = join(dataDir, "cron");
    if (!existsSync(cronDir)) mkdirSync(cronDir, { recursive: true, mode: 0o700 });
    this.jobsFile = join(cronDir, "jobs.json");
    this.settingsFile = join(cronDir, "settings.json");
    this.history = new RunHistoryStore(dataDir);
    this.loadJobs();
    this.loadSettings();
  }

  getDataDir(): string { return this.dataDir; }
  getHistory(): RunHistoryStore { return this.history; }
  listHistory(jobId: string, limit = 50): CronRunRecord[] { return this.history.list(jobId, limit); }

  private loadJobs(): void {
    if (!existsSync(this.jobsFile)) return;
    try {
      const data = JSON.parse(readFileSync(this.jobsFile, "utf-8"));
      this.jobs.clear();
      for (const job of data) this.jobs.set(job.id, job);
      this.lastFileMtime = statSync(this.jobsFile).mtimeMs;
    } catch { /* corrupt file — keep current state */ }
  }

  private reloadIfChanged(): void {
    if (!existsSync(this.jobsFile)) return;
    try {
      const mtime = statSync(this.jobsFile).mtimeMs;
      if (mtime > this.lastFileMtime) {
        logger.info(`[cron] jobs.json changed externally — reloading`);
        this.loadJobs();
        if (this.settings.enabled) {
          for (const job of this.jobs.values()) {
            if (job.enabled && !this.timers.has(job.id)) this.scheduleJob(job);
          }
        }
      }
    } catch { /* ignore */ }
  }

  private saveJobs(): void {
    writeFileSync(this.jobsFile, JSON.stringify([...this.jobs.values()], null, 2), "utf-8");
    try { this.lastFileMtime = statSync(this.jobsFile).mtimeMs; } catch { /* ignore */ }
  }

  private loadSettings(): void {
    if (!existsSync(this.settingsFile)) return;
    try {
      this.settings = { ...DEFAULT_SETTINGS, ...JSON.parse(readFileSync(this.settingsFile, "utf-8")) };
    } catch { /* keep defaults */ }
  }

  onExecute(handler: ExecuteHandler): void { this.executeHandler = handler; }

  /** Computed next-run time for a job, in ISO. Returns null if disabled / unscheduled. */
  getNextRunAt(job: CronJob): string | null {
    if (!job.enabled || !this.settings.enabled) return null;
    const ms = msUntilNextRun(job.schedule);
    if (ms == null) return null;
    return new Date(Date.now() + ms).toISOString();
  }

  start(): void {
    if (!this.settings.enabled) return;
    let catchUpIndex = 0;
    for (const job of this.jobs.values()) {
      if (!job.enabled) continue;
      this.scheduleJob(job);

      const msSince = msSinceLastCronOccurrence(job.schedule, job.lastRun);
      if (msSince === null || msSince > 24 * 3600_000) continue;

      const missedTime = new Date(Date.now() - msSince).toISOString();
      const delay = 60_000 + catchUpIndex * 30_000;
      catchUpIndex++;
      logger.info(`[cron] Catching up missed run for ${job.name} (last run: ${job.lastRun || "never"}, missed scheduled time: ${missedTime})`);
      setTimeout(() => this.executeJob(job, { manual: false, isCatchUp: true }), delay);
    }
    logger.info(`[cron] Started with ${this.jobs.size} jobs`);
  }

  stop(): void {
    for (const [, timer] of this.timers) {
      clearInterval(timer);
      clearTimeout(timer as unknown as ReturnType<typeof setTimeout>);
    }
    this.timers.clear();
  }

  private scheduleJob(job: CronJob): void {
    const existing = this.timers.get(job.id);
    if (existing) clearInterval(existing);

    const fixedMs = getIntervalMs(job.schedule);
    if (fixedMs) {
      const timer = setInterval(() => this.executeJob(job, { manual: false }), fixedMs);
      this.timers.set(job.id, timer);
    } else {
      this.scheduleCronRun(job);
    }
  }

  private scheduleCronRun(job: CronJob): void {
    const ms = msUntilNextCron(job.schedule);
    if (!ms) return;
    const timer = setTimeout(async () => {
      await this.executeJob(job, { manual: false });
      if (job.enabled) this.scheduleCronRun(job);
    }, ms);
    this.timers.set(job.id, timer as unknown as ReturnType<typeof setInterval>);
    const nextRun = new Date(Date.now() + ms);
    logger.info(`[cron] ${job.name}: next run at ${nextRun.toLocaleString()} (${Math.round(ms / 60000)}m from now)`);
  }

  /**
   * Public entrypoint for executing a job (used by the timer, catch-up, and
   * the run-now API). Records a history entry for every attempt — including
   * skipped runs — and tracks consecutive failures with bounded retries.
   */
  async executeJob(
    job: CronJob,
    opts: { manual: boolean; isCatchUp?: boolean } = { manual: false },
  ): Promise<void> {
    if (!this.executeHandler) return;
    const scheduledAt = new Date().toISOString();

    if (this.running.has(job.id)) {
      this.recordSkip(job, scheduledAt, opts.manual, "previous run still active");
      logger.warn(`[cron] Job ${job.name} (${job.id}) skipped — prior run still active`);
      return;
    }

    if (this.running.size >= this.settings.maxConcurrent) {
      const count = (this.concurrencyDeferCount.get(job.id) || 0) + 1;
      if (count > 3) {
        this.concurrencyDeferCount.delete(job.id);
        this.recordSkip(job, scheduledAt, opts.manual, `concurrency limit ${this.settings.maxConcurrent} full after 3 retries`);
        logger.error(`[cron] Job ${job.name} (${job.id}) skipped — concurrency limit ${this.settings.maxConcurrent} still full after 3 retries`);
        return;
      }
      this.concurrencyDeferCount.set(job.id, count);
      logger.warn(`[cron] Job ${job.name} (${job.id}) deferred — concurrency limit ${this.settings.maxConcurrent} reached, retry ${count}/3 in 60s`);
      setTimeout(() => this.executeJob(job, opts), 60_000);
      return;
    }
    this.concurrencyDeferCount.delete(job.id);

    this.running.add(job.id);
    const startedAt = new Date().toISOString();
    const startMs = Date.now();
    try {
      logger.info(`[cron] Running job: ${job.name} (${job.id})${opts.manual ? " [manual]" : ""}`);
      const raw = await this.executeHandler(job.id, job.prompt, { scheduledAt, manual: opts.manual });
      const result: ExecuteResult = typeof raw === "string" ? { output: raw } : raw;
      const finishedAt = new Date().toISOString();
      const durationMs = Date.now() - startMs;
      const status = this.classifyStatus(result);

      job.lastRun = finishedAt;
      job.lastResult = summarize(result.output);
      if (result.reportPath) job.lastReportPath = result.reportPath;
      job.lastStatus = status;
      job.lastErrorMessage = status === "success" ? undefined : (result.errorMessage || extractErrorMessage(result.output));

      if (status === "success") {
        job.consecutiveFailures = 0;
        job.lastSuccessAt = finishedAt;
        this.transientRetryCount.delete(job.id);
      } else {
        job.consecutiveFailures = (job.consecutiveFailures || 0) + 1;
      }
      this.saveJobs();

      this.history.append({
        id: newRunId(),
        jobId: job.id,
        jobName: job.name,
        scheduledAt,
        startedAt,
        finishedAt,
        durationMs,
        status,
        manual: opts.manual,
        outputSummary: summarize(result.output),
        reportPath: result.reportPath,
        errorMessage: status === "success" ? undefined : (result.errorMessage || extractErrorMessage(result.output)),
        provider: result.provider,
        model: result.model,
      });

      this.maybeAutoPause(job);
    } catch (e) {
      const finishedAt = new Date().toISOString();
      const durationMs = Date.now() - startMs;
      const errorMessage = (e as Error).message || String(e);
      logger.error(`[cron] Job failed: ${job.name}:`, errorMessage);

      job.lastRun = finishedAt;
      job.lastResult = `ERROR: ${errorMessage}`;
      job.lastStatus = "error";
      job.lastErrorMessage = errorMessage;
      job.consecutiveFailures = (job.consecutiveFailures || 0) + 1;
      this.saveJobs();

      this.history.append({
        id: newRunId(),
        jobId: job.id,
        jobName: job.name,
        scheduledAt,
        startedAt,
        finishedAt,
        durationMs,
        status: "error",
        manual: opts.manual,
        errorMessage,
      });

      this.scheduleTransientRetry(job, opts);
      this.maybeAutoPause(job);
    } finally {
      this.running.delete(job.id);
    }
  }

  private classifyStatus(result: ExecuteResult): CronRunStatus {
    if (result.status) return result.status;
    const head = (result.output || "").trim().slice(0, 16).toUpperCase();
    if (head.startsWith("FAILED:")) return "failed";
    if (head.startsWith("ERROR:")) return "error";
    return "success";
  }

  private recordSkip(job: CronJob, scheduledAt: string, manual: boolean, reason: string): void {
    const now = new Date().toISOString();
    job.lastStatus = "skipped";
    job.lastErrorMessage = reason;
    this.saveJobs();
    this.history.append({
      id: newRunId(),
      jobId: job.id,
      jobName: job.name,
      scheduledAt,
      startedAt: now,
      finishedAt: now,
      durationMs: 0,
      status: "skipped",
      manual,
      errorMessage: reason,
    });
  }

  private scheduleTransientRetry(job: CronJob, opts: { manual: boolean; isCatchUp?: boolean }): void {
    if (opts.manual) return; // manual runs surface failure to the caller; no auto-retry
    const attempt = (this.transientRetryCount.get(job.id) || 0);
    if (attempt >= this.settings.maxTransientRetries) {
      this.transientRetryCount.delete(job.id);
      return;
    }
    const delay = TRANSIENT_BACKOFF_MS[Math.min(attempt, TRANSIENT_BACKOFF_MS.length - 1)];
    this.transientRetryCount.set(job.id, attempt + 1);
    logger.warn(`[cron] Job ${job.name}: scheduling transient retry ${attempt + 1}/${this.settings.maxTransientRetries} in ${Math.round(delay / 1000)}s`);
    setTimeout(() => {
      if (!job.enabled) return;
      this.executeJob(job, { manual: false }).catch(() => { /* logged inside */ });
    }, delay);
  }

  private maybeAutoPause(job: CronJob): void {
    const cap = this.settings.maxConsecutiveFailures;
    if (cap <= 0) return;
    if ((job.consecutiveFailures || 0) < cap) return;
    if (!job.enabled) return;
    job.enabled = false;
    this.saveJobs();
    const timer = this.timers.get(job.id);
    if (timer) { clearInterval(timer); this.timers.delete(job.id); }
    logger.error(`[cron] Auto-paused job ${job.name} (${job.id}) after ${job.consecutiveFailures} consecutive failures`);
  }

  create(name: string, schedule: string, prompt: string, systemJob?: boolean): CronJob {
    if (prompt.length > 5000) throw new Error("Cron job prompt too long (max 5000 characters)");
    if (!schedule || schedule.trim().length === 0) throw new Error("Schedule is required");
    const existing = [...this.jobs.values()].find(j => j.name === name);
    if (existing) {
      logger.info(`[cron] Updated existing job ${name} instead of creating duplicate`);
      return this.update(existing.id, { schedule, prompt }) || existing;
    }
    const id = `cron_${Date.now().toString(36)}`;
    const job: CronJob = {
      id, name, schedule, prompt,
      enabled: true,
      systemJob: systemJob || false,
      consecutiveFailures: 0,
      createdAt: new Date().toISOString(),
    };
    this.jobs.set(id, job);
    this.saveJobs();
    if (this.settings.enabled) this.scheduleJob(job);
    return job;
  }

  update(id: string, updates: Partial<CronJob>): CronJob | null {
    const job = this.jobs.get(id);
    if (!job) return null;
    Object.assign(job, updates, { id });
    this.saveJobs();
    if (job.enabled) this.scheduleJob(job);
    else {
      const timer = this.timers.get(id);
      if (timer) { clearInterval(timer); this.timers.delete(id); }
    }
    return job;
  }

  delete(id: string): boolean {
    const timer = this.timers.get(id);
    if (timer) { clearInterval(timer); this.timers.delete(id); }
    const deleted = this.jobs.delete(id);
    if (deleted) {
      this.saveJobs();
      this.history.purge(id);
    }
    return deleted;
  }

  toggle(id: string): CronJob | null {
    const job = this.jobs.get(id);
    if (!job) return null;
    job.enabled = !job.enabled;
    if (job.enabled) {
      job.consecutiveFailures = 0; // resume = clear failure streak
      this.scheduleJob(job);
    } else {
      const timer = this.timers.get(id);
      if (timer) { clearInterval(timer); this.timers.delete(id); }
    }
    this.saveJobs();
    return job;
  }

  list(): CronJob[] {
    this.reloadIfChanged();
    return [...this.jobs.values()];
  }

  get(id: string): CronJob | null {
    this.reloadIfChanged();
    return this.jobs.get(id) || null;
  }

  isRunning(id: string): boolean { return this.running.has(id); }

  getSettings(): CronSettings { return { ...this.settings }; }

  updateSettings(updates: Partial<CronSettings>): void {
    this.settings = { ...this.settings, ...updates };
    writeFileSync(this.settingsFile, JSON.stringify(this.settings, null, 2), "utf-8");
    if (this.settings.enabled) this.start();
    else this.stop();
  }
}

function extractErrorMessage(output: string): string | undefined {
  const trimmed = (output || "").trim();
  if (!trimmed) return undefined;
  const firstLine = trimmed.split("\n")[0].trim();
  return firstLine.length > 240 ? firstLine.slice(0, 240) + "…" : firstLine;
}

// ── Tool exports (re-export to preserve the existing import surface) ──

export const createCronTools: (cron: CronService) => ToolDefinition[] = _createCronTools;
