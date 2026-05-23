/**
 * Cron service — execution + retry state machine.
 *
 * Standalone helpers that operate on a CronService instance. Kept out of
 * the main cron-service.ts so the class file stays focused on lifecycle +
 * persistence + CRUD. CronService re-exposes `runJob` via its public
 * `executeJob` method so external callers still go through the class.
 *
 * Accesses CronService internals (running, history, settings, jobs, …)
 * through public fields marked `@internal` in cron-service.ts.
 */

import { createLogger } from "../logger.js";
import { newRunId, summarize } from "./run-history.js";
import {
  classifyStatus,
  extractErrorMessage,
  TRANSIENT_BACKOFF_MS,
  type CronJob,
  type ExecuteResult,
} from "./cron-service-types.js";
import type { CronService } from "../cron-service.js";

const logger = createLogger("cron-service");

export async function runJob(
  svc: CronService,
  job: CronJob,
  opts: { manual: boolean; isCatchUp?: boolean } = { manual: false },
): Promise<void> {
  if (!svc.executeHandler) return;
  const scheduledAt = new Date().toISOString();

  if (svc.running.has(job.id)) {
    recordSkip(svc, job, scheduledAt, opts.manual, "previous run still active");
    logger.warn(`[cron] Job ${job.name} (${job.id}) skipped — prior run still active`);
    return;
  }

  if (svc.running.size >= svc.settings.maxConcurrent) {
    const count = (svc.concurrencyDeferCount.get(job.id) || 0) + 1;
    if (count > 3) {
      svc.concurrencyDeferCount.delete(job.id);
      recordSkip(svc, job, scheduledAt, opts.manual, `concurrency limit ${svc.settings.maxConcurrent} full after 3 retries`);
      logger.error(`[cron] Job ${job.name} (${job.id}) skipped — concurrency limit ${svc.settings.maxConcurrent} still full after 3 retries`);
      return;
    }
    svc.concurrencyDeferCount.set(job.id, count);
    logger.warn(`[cron] Job ${job.name} (${job.id}) deferred — concurrency limit ${svc.settings.maxConcurrent} reached, retry ${count}/3 in 60s`);
    setTimeout(() => svc.executeJob(job, opts), 60_000);
    return;
  }
  svc.concurrencyDeferCount.delete(job.id);

  svc.running.add(job.id);
  const startedAt = new Date().toISOString();
  const startMs = Date.now();
  try {
    logger.info(`[cron] Running job: ${job.name} (${job.id})${opts.manual ? " [manual]" : ""}`);
    const raw = await svc.executeHandler(job.id, job.prompt, { scheduledAt, manual: opts.manual });
    const result: ExecuteResult = typeof raw === "string" ? { output: raw } : raw;
    const finishedAt = new Date().toISOString();
    const durationMs = Date.now() - startMs;
    const status = classifyStatus(result);

    job.lastRun = finishedAt;
    job.lastResult = summarize(result.output);
    if (result.reportPath) job.lastReportPath = result.reportPath;
    job.lastStatus = status;
    job.lastErrorMessage = status === "success" ? undefined : (result.errorMessage || extractErrorMessage(result.output));

    if (status === "success") {
      job.consecutiveFailures = 0;
      job.lastSuccessAt = finishedAt;
      svc.transientRetryCount.delete(job.id);
    } else {
      job.consecutiveFailures = (job.consecutiveFailures || 0) + 1;
    }
    svc.saveJobs();

    svc.history.append({
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

    maybeAutoPause(svc, job);
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
    svc.saveJobs();

    svc.history.append({
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

    scheduleTransientRetry(svc, job, opts);
    maybeAutoPause(svc, job);
  } finally {
    svc.running.delete(job.id);
  }
}

function recordSkip(svc: CronService, job: CronJob, scheduledAt: string, manual: boolean, reason: string): void {
  const now = new Date().toISOString();
  job.lastStatus = "skipped";
  job.lastErrorMessage = reason;
  svc.saveJobs();
  svc.history.append({
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

function scheduleTransientRetry(svc: CronService, job: CronJob, opts: { manual: boolean; isCatchUp?: boolean }): void {
  if (opts.manual) return; // manual runs surface failure to the caller; no auto-retry
  const attempt = (svc.transientRetryCount.get(job.id) || 0);
  if (attempt >= svc.settings.maxTransientRetries) {
    svc.transientRetryCount.delete(job.id);
    return;
  }
  const delay = TRANSIENT_BACKOFF_MS[Math.min(attempt, TRANSIENT_BACKOFF_MS.length - 1)];
  svc.transientRetryCount.set(job.id, attempt + 1);
  logger.warn(`[cron] Job ${job.name}: scheduling transient retry ${attempt + 1}/${svc.settings.maxTransientRetries} in ${Math.round(delay / 1000)}s`);
  setTimeout(() => {
    if (!job.enabled) return;
    svc.executeJob(job, { manual: false }).catch(() => { /* logged inside */ });
  }, delay);
}

function maybeAutoPause(svc: CronService, job: CronJob): void {
  const cap = svc.settings.maxConsecutiveFailures;
  if (cap <= 0) return;
  if ((job.consecutiveFailures || 0) < cap) return;
  if (!job.enabled) return;
  job.enabled = false;
  svc.saveJobs();
  const timer = svc.timers.get(job.id);
  if (timer) { clearInterval(timer); svc.timers.delete(job.id); }
  logger.error(`[cron] Auto-paused job ${job.name} (${job.id}) after ${job.consecutiveFailures} consecutive failures`);
}
