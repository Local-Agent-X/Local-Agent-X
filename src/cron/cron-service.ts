/**
 * Cron Service for Local Agent X
 *
 * Runs scheduled jobs (prompts) at defined intervals. Jobs persist to disk so
 * they survive restarts. Each run is recorded in a per-job history file (see
 * `src/cron/run-history.ts`) regardless of whether it succeeded, failed,
 * errored, or was skipped due to overlap with a still-running prior execution.
 *
 * Types / pure helpers: src/cron/cron-service-types.ts
 * Execution + retry machine: src/cron/cron-service-execute.ts
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync, statSync, renameSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import type { ToolDefinition } from "../types.js";

import { createLogger } from "../logger.js";
import {
  msUntilNextCron,
  msSinceLastCronOccurrence,
  getIntervalMs,
  msUntilNextRun,
} from "./cron-parser.js";
import {
  RunHistoryStore,
  type CronRunRecord,
} from "./run-history.js";
import { createCronTools as _createCronTools } from "./tools.js";
import {
  DEFAULT_SETTINGS,
  type CronJob,
  type CronSettings,
  type ExecuteHandler,
} from "./cron-service-types.js";
import { runJob } from "./cron-service-execute.js";
import type { ProfileName } from "../autonomy/profiles.js";

export type { CronJob, CronSettings, ExecuteResult, ExecuteContext, ExecuteHandler } from "./cron-service-types.js";

const logger = createLogger("cron-service");

export class CronService {
  private jobs_internal: Map<string, CronJob> = new Map();
  private timers_internal: Map<string, ReturnType<typeof setInterval>> = new Map();
  private dataDir: string;
  private jobsFile: string;
  private settingsFile: string;
  /** @internal accessed by cron-service-execute.ts */
  settings: CronSettings = { ...DEFAULT_SETTINGS };
  /** @internal accessed by cron-service-execute.ts */
  executeHandler: ExecuteHandler | null = null;
  /** @internal accessed by cron-service-execute.ts */
  running = new Set<string>();
  private runAborts = new Map<string, AbortController>();
  /** @internal accessed by cron-service-execute.ts */
  concurrencyDeferCount = new Map<string, number>();
  /** @internal accessed by cron-service-execute.ts */
  transientRetryCount = new Map<string, number>();
  private lastFileMtime = 0;
  /** @internal accessed by cron-service-execute.ts */
  history: RunHistoryStore;

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

  /** @internal exposed for cron-service-execute.ts */
  get jobs(): Map<string, CronJob> { return this.jobs_internal; }
  /** @internal exposed for cron-service-execute.ts */
  get timers(): Map<string, ReturnType<typeof setInterval>> { return this.timers_internal; }

  getDataDir(): string { return this.dataDir; }
  getHistory(): RunHistoryStore { return this.history; }
  listHistory(jobId: string, limit = 50): CronRunRecord[] { return this.history.list(jobId, limit); }

  private loadJobs(): void {
    if (!existsSync(this.jobsFile)) return;
    try {
      const data = JSON.parse(readFileSync(this.jobsFile, "utf-8"));
      this.jobs_internal.clear();
      for (const job of data) this.jobs_internal.set(job.id, job);
      this.lastFileMtime = statSync(this.jobsFile).mtimeMs;
    } catch (e) {
      // Log loudly — silent corruption used to silently swallow jobs.json
      // and leave the user wondering why scheduled missions never fired.
      logger.error(`[cron] FAILED to load ${this.jobsFile}: ${(e as Error).message} — existing in-memory jobs preserved, new writes will overwrite the file`);
    }
  }

  private reloadIfChanged(): void {
    if (!existsSync(this.jobsFile)) return;
    try {
      const mtime = statSync(this.jobsFile).mtimeMs;
      if (mtime > this.lastFileMtime) {
        logger.info(`[cron] jobs.json changed externally — reloading`);
        this.loadJobs();
        if (this.settings.enabled) {
          for (const job of this.jobs_internal.values()) {
            if (job.enabled && !this.timers_internal.has(job.id)) this.scheduleJob(job);
          }
        }
      }
    } catch (e) {
      logger.warn(`[cron] reloadIfChanged check failed: ${(e as Error).message}`);
    }
  }

  /** @internal called by cron-service-execute.ts */
  saveJobs(): void {
    // Atomic write: write to .tmp, fsync via close, then rename. Avoids
    // half-written jobs.json being readable by a concurrent reloadIfChanged
    // that would crash on JSON.parse mid-write. Mirrors POSIX-safe save
    // patterns. The temp file is cleaned up if rename fails so we don't
    // leak .tmp files on disk.
    const tmpPath = `${this.jobsFile}.tmp`;
    try {
      writeFileSync(tmpPath, JSON.stringify([...this.jobs_internal.values()], null, 2), "utf-8");
      renameSync(tmpPath, this.jobsFile);
    } catch (e) {
      try { if (existsSync(tmpPath)) unlinkSync(tmpPath); } catch { /* tmp cleanup is best-effort */ }
      logger.error(`[cron] FAILED to persist ${this.jobsFile}: ${(e as Error).message} — in-memory state diverges from disk until next successful save`);
      return;
    }
    try { this.lastFileMtime = statSync(this.jobsFile).mtimeMs; } catch (e) {
      logger.warn(`[cron] stat after save failed: ${(e as Error).message}`);
    }
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
    for (const job of this.jobs_internal.values()) {
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
    logger.info(`[cron] Started with ${this.jobs_internal.size} jobs`);
  }

  stop(): void {
    for (const [, timer] of this.timers_internal) {
      clearInterval(timer);
      clearTimeout(timer as unknown as ReturnType<typeof setTimeout>);
    }
    this.timers_internal.clear();
  }

  private scheduleJob(job: CronJob): void {
    const existing = this.timers_internal.get(job.id);
    if (existing) clearInterval(existing);

    const fixedMs = getIntervalMs(job.schedule);
    if (fixedMs) {
      const timer = setInterval(() => this.executeJob(job, { manual: false }), fixedMs);
      this.timers_internal.set(job.id, timer);
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
    this.timers_internal.set(job.id, timer as unknown as ReturnType<typeof setInterval>);
    const nextRun = new Date(Date.now() + ms);
    logger.info(`[cron] ${job.name}: next run at ${nextRun.toLocaleString()} (${Math.round(ms / 60000)}m from now)`);
  }

  /**
   * Public entrypoint for executing a job (used by the timer, catch-up, and
   * the run-now API). Records a history entry for every attempt — including
   * skipped runs — and tracks consecutive failures with bounded retries.
   * Body lives in cron-service-execute.ts so this file stays under 400 LOC.
   */
  executeJob(job: CronJob, opts: { manual: boolean; isCatchUp?: boolean } = { manual: false }): Promise<void> {
    return runJob(this, job, opts);
  }

  create(name: string, schedule: string, prompt: string, systemJob?: boolean, opts?: { provider?: string; model?: string; profile?: ProfileName }): CronJob {
    if (prompt.length > 5000) throw new Error("Cron job prompt too long (max 5000 characters)");
    if (!schedule || schedule.trim().length === 0) throw new Error("Schedule is required");
    // Validate the schedule by attempting to compute next-run time. Without
    // this, malformed expressions (e.g. "* * * *" — only 4 fields) silently
    // never schedule a timer and the user sees an enabled job that never
    // fires. Either a fixed interval ("5m", "1h") OR a cron expression with
    // a parseable next-run is acceptable.
    if (getIntervalMs(schedule) === null && msUntilNextRun(schedule) === null) {
      throw new Error(`Invalid schedule "${schedule}" — must be a cron expression (e.g. "0 22 * * *") or fixed interval (e.g. "5m", "1h")`);
    }
    const existing = [...this.jobs_internal.values()].find(j => j.name === name);
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
      ...(opts?.provider ? { provider: opts.provider } : {}),
      ...(opts?.model ? { model: opts.model } : {}),
      ...(opts?.profile ? { profile: opts.profile } : {}),
    };
    this.jobs_internal.set(id, job);
    this.saveJobs();
    if (this.settings.enabled) this.scheduleJob(job);
    return job;
  }

  update(id: string, updates: Partial<CronJob>): CronJob | null {
    const job = this.jobs_internal.get(id);
    if (!job) return null;
    Object.assign(job, updates, { id });
    this.saveJobs();
    if (job.enabled) this.scheduleJob(job);
    else {
      const timer = this.timers_internal.get(id);
      if (timer) { clearInterval(timer); this.timers_internal.delete(id); }
    }
    return job;
  }

  delete(id: string): boolean {
    const timer = this.timers_internal.get(id);
    if (timer) { clearInterval(timer); this.timers_internal.delete(id); }
    // Abort any in-flight run for this job. Without this, a delete while
    // the mission is mid-execution leaves an orphaned 20-minute run
    // writing a report to a deleted job's directory — confusing state.
    const inFlight = this.runAborts.get(id);
    if (inFlight) {
      logger.info(`[cron] Aborting in-flight run for deleted job ${id}`);
      try { inFlight.abort(); } catch (e) { logger.warn(`[cron] Abort error on delete: ${(e as Error).message}`); }
      this.runAborts.delete(id);
    }
    this.running.delete(id);
    this.concurrencyDeferCount.delete(id);
    const deleted = this.jobs_internal.delete(id);
    if (deleted) {
      this.saveJobs();
      this.history.purge(id);
    }
    return deleted;
  }

  toggle(id: string): CronJob | null {
    const job = this.jobs_internal.get(id);
    if (!job) return null;
    job.enabled = !job.enabled;
    if (job.enabled) {
      job.consecutiveFailures = 0; // resume = clear failure streak
      this.scheduleJob(job);
    } else {
      const timer = this.timers_internal.get(id);
      if (timer) { clearInterval(timer); this.timers_internal.delete(id); }
    }
    this.saveJobs();
    return job;
  }

  list(): CronJob[] {
    this.reloadIfChanged();
    return [...this.jobs_internal.values()];
  }

  get(id: string): CronJob | null {
    this.reloadIfChanged();
    return this.jobs_internal.get(id) || null;
  }

  isRunning(id: string): boolean { return this.running.has(id); }

  /**
   * Lets the executeHandler register the AbortController that owns the
   * agent loop for this run, so external callers (UI Stop button) can
   * cancel an in-flight mission. The handler still controls timeout and
   * abort-on-finally; the cron service just brokers external access.
   */
  registerRunAbort(id: string, ctrl: AbortController): void { this.runAborts.set(id, ctrl); }
  unregisterRunAbort(id: string): void { this.runAborts.delete(id); }

  /** Returns true if there was an in-flight run to cancel. */
  cancelRun(id: string): boolean {
    const ctrl = this.runAborts.get(id);
    if (!ctrl) return false;
    ctrl.abort();
    logger.warn(`[cron] Job ${id}: run cancelled by user`);
    return true;
  }

  /**
   * Acknowledge and dismiss the last failure surface for a job: clears
   * the sticky error message, demotes the status badge from failed/error,
   * and resets the consecutive-failure streak. Useful after the user has
   * read or fixed the underlying problem and wants a clean panel.
   */
  clearLastError(id: string): boolean {
    const job = this.jobs_internal.get(id);
    if (!job) return false;
    job.lastErrorMessage = undefined;
    if (job.lastStatus === "failed" || job.lastStatus === "error") job.lastStatus = undefined;
    job.consecutiveFailures = 0;
    this.transientRetryCount.delete(id);
    this.saveJobs();
    return true;
  }

  getSettings(): CronSettings { return { ...this.settings }; }

  updateSettings(updates: Partial<CronSettings>): void {
    this.settings = { ...this.settings, ...updates };
    writeFileSync(this.settingsFile, JSON.stringify(this.settings, null, 2), "utf-8");
    if (this.settings.enabled) this.start();
    else this.stop();
  }
}

// ── Tool exports (re-export to preserve the existing import surface) ──

export const createCronTools: (cron: CronService) => ToolDefinition[] = _createCronTools;
