/**
 * Cron Service for Local Agent X
 *
 * Runs scheduled jobs (prompts) at defined intervals.
 * Jobs persist to disk so they survive restarts.
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type { ToolDefinition } from "./types.js";

import { createLogger } from "./logger.js";
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
  createdAt: string;
}

interface CronSettings {
  enabled: boolean;
  maxConcurrent: number;
}

interface ExecuteResult { output: string; reportPath?: string }
type ExecuteHandler = (jobId: string, prompt: string) => Promise<string | ExecuteResult>;

// Parse simple interval strings like "5m", "1h", "30s"
function parseInterval(schedule: string): number | null {
  const match = schedule.match(/^(\d+)(s|m|h|d)$/);
  if (!match) return null;
  const [, num, unit] = match;
  const multipliers: Record<string, number> = { s: 1000, m: 60000, h: 3600000, d: 86400000 };
  return parseInt(num) * (multipliers[unit] || 60000);
}

// Check if a cron field matches a value. Supports: *, N, star-slash-N, N-M, comma lists
function cronFieldMatches(field: string, value: number, max: number): boolean {
  for (const part of field.split(",")) {
    const trimmed = part.trim();
    if (trimmed === "*") return true;
    if (trimmed.startsWith("*/")) {
      const step = parseInt(trimmed.slice(2));
      if (!isNaN(step) && step > 0 && value % step === 0) return true;
    } else if (trimmed.includes("-")) {
      const [lo, hi] = trimmed.split("-").map(Number);
      if (!isNaN(lo) && !isNaN(hi) && value >= lo && value <= hi) return true;
    } else {
      if (parseInt(trimmed) === value) return true;
    }
  }
  return false;
}

/** Calculate ms until next cron match (minute hour dom month dow). Returns null for non-cron. */
function msUntilNextCron(schedule: string): number | null {
  const parts = schedule.trim().split(/\s+/);
  if (parts.length !== 5) return null;
  const [minField, hourField, domField, monField, dowField] = parts;

  const now = new Date();
  // Scan up to 48 hours ahead to find next match
  for (let offset = 1; offset <= 2880; offset++) {
    const candidate = new Date(now.getTime() + offset * 60_000);
    const min = candidate.getMinutes();
    const hour = candidate.getHours();
    const dom = candidate.getDate();
    const mon = candidate.getMonth() + 1;
    const dow = candidate.getDay(); // 0=Sun
    if (
      cronFieldMatches(minField, min, 59) &&
      cronFieldMatches(hourField, hour, 23) &&
      cronFieldMatches(domField, dom, 31) &&
      cronFieldMatches(monField, mon, 12) &&
      cronFieldMatches(dowField, dow, 6)
    ) {
      return offset * 60_000;
    }
  }
  // Fallback: 24h if no match found in scan window
  return 24 * 3600_000;
}

/** Counterpart to msUntilNextCron. Returns how long ago the most recent matching cron
 *  time was. If lastRun is provided and is at or after that occurrence, returns null
 *  (no missed run). Returns null for non-cron schedules or if no match in the past 48h. */
function msSinceLastCronOccurrence(schedule: string, lastRun?: string): number | null {
  const parts = schedule.trim().split(/\s+/);
  if (parts.length !== 5) return null;
  const [minField, hourField, domField, monField, dowField] = parts;

  const now = new Date();
  for (let offset = 1; offset <= 2880; offset++) {
    const candidate = new Date(now.getTime() - offset * 60_000);
    const min = candidate.getMinutes();
    const hour = candidate.getHours();
    const dom = candidate.getDate();
    const mon = candidate.getMonth() + 1;
    const dow = candidate.getDay();
    if (
      cronFieldMatches(minField, min, 59) &&
      cronFieldMatches(hourField, hour, 23) &&
      cronFieldMatches(domField, dom, 31) &&
      cronFieldMatches(monField, mon, 12) &&
      cronFieldMatches(dowField, dow, 6)
    ) {
      if (lastRun && new Date(lastRun).getTime() >= candidate.getTime()) return null;
      return offset * 60_000;
    }
  }
  return null;
}

/** For simple interval schedules, return fixed ms. For cron expressions, return null. */
function getIntervalMs(schedule: string): number | null {
  const interval = parseInterval(schedule);
  if (interval) return Math.max(interval, 60000);
  // Check if it's a */N pattern (uniform interval cron)
  const parts = schedule.trim().split(/\s+/);
  if (parts.length === 5 && parts[0].startsWith("*/") && parts.slice(1).every(p => p === "*")) {
    const step = parseInt(parts[0].slice(2));
    if (!isNaN(step)) return Math.max(step * 60000, 60000);
  }
  return null; // Full cron expression — needs dynamic scheduling
}

export class CronService {
  private jobs: Map<string, CronJob> = new Map();
  private timers: Map<string, ReturnType<typeof setInterval>> = new Map();
  private dataDir: string;
  private jobsFile: string;
  private settingsFile: string;
  private settings: CronSettings = { enabled: true, maxConcurrent: 3 };
  private executeHandler: ExecuteHandler | null = null;
  private running = new Set<string>();
  private retryCount = new Map<string, number>();
  private lastFileMtime = 0;

  constructor(dataDir: string) {
    this.dataDir = dataDir;
    const cronDir = join(dataDir, "cron");
    if (!existsSync(cronDir)) mkdirSync(cronDir, { recursive: true, mode: 0o700 });
    this.jobsFile = join(cronDir, "jobs.json");
    this.settingsFile = join(cronDir, "settings.json");
    this.loadJobs();
    this.loadSettings();
  }

  private loadJobs(): void {
    if (existsSync(this.jobsFile)) {
      try {
        const data = JSON.parse(readFileSync(this.jobsFile, "utf-8"));
        this.jobs.clear();
        for (const job of data) this.jobs.set(job.id, job);
        const { statSync } = require("node:fs");
        this.lastFileMtime = statSync(this.jobsFile).mtimeMs;
      } catch {}
    }
  }

  /** Re-load jobs from disk if the file was modified externally (e.g., by an agent writing to it). */
  private reloadIfChanged(): void {
    if (!existsSync(this.jobsFile)) return;
    try {
      const { statSync } = require("node:fs");
      const mtime = statSync(this.jobsFile).mtimeMs;
      if (mtime > this.lastFileMtime) {
        logger.info(`[cron] jobs.json changed externally — reloading`);
        this.loadJobs();
        // Reschedule any new/changed jobs
        if (this.settings.enabled) {
          for (const job of this.jobs.values()) {
            if (job.enabled && !this.timers.has(job.id)) this.scheduleJob(job);
          }
        }
      }
    } catch {}
  }

  private saveJobs(): void {
    writeFileSync(this.jobsFile, JSON.stringify([...this.jobs.values()], null, 2), "utf-8");
    try {
      const { statSync } = require("node:fs");
      this.lastFileMtime = statSync(this.jobsFile).mtimeMs;
    } catch {}
  }

  private loadSettings(): void {
    if (existsSync(this.settingsFile)) {
      try {
        this.settings = { ...this.settings, ...JSON.parse(readFileSync(this.settingsFile, "utf-8")) };
      } catch {}
    }
  }

  onExecute(handler: ExecuteHandler): void {
    this.executeHandler = handler;
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
      setTimeout(() => this.executeJob(job), delay);
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
    // Clear existing timer
    const existing = this.timers.get(job.id);
    if (existing) clearInterval(existing);

    const fixedMs = getIntervalMs(job.schedule);
    if (fixedMs) {
      // Simple interval — use setInterval
      const timer = setInterval(() => this.executeJob(job), fixedMs);
      this.timers.set(job.id, timer);
    } else {
      // Full cron expression — schedule next run dynamically
      this.scheduleCronRun(job);
    }
  }

  private scheduleCronRun(job: CronJob): void {
    const ms = msUntilNextCron(job.schedule);
    if (!ms) return;
    const timer = setTimeout(async () => {
      await this.executeJob(job);
      // Re-schedule for next occurrence
      if (job.enabled) this.scheduleCronRun(job);
    }, ms);
    this.timers.set(job.id, timer as unknown as ReturnType<typeof setInterval>);
    const nextRun = new Date(Date.now() + ms);
    logger.info(`[cron] ${job.name}: next run at ${nextRun.toLocaleString()} (${Math.round(ms / 60000)}m from now)`);
  }

  private async executeJob(job: CronJob): Promise<void> {
    if (!this.executeHandler) return;
    if (this.running.size >= this.settings.maxConcurrent) {
      const count = (this.retryCount.get(job.id) || 0) + 1;
      if (count > 3) {
        logger.error(`[cron] Job ${job.name} (${job.id}) skipped — concurrency limit ${this.settings.maxConcurrent} still full after 3 retries; giving up until next scheduled run`);
        this.retryCount.delete(job.id);
        return;
      }
      this.retryCount.set(job.id, count);
      logger.warn(`[cron] Job ${job.name} (${job.id}) deferred — concurrency limit ${this.settings.maxConcurrent} reached, retry ${count}/3 in 60s`);
      setTimeout(() => this.executeJob(job), 60_000);
      return;
    }
    if (this.running.has(job.id)) return;
    this.retryCount.delete(job.id);

    this.running.add(job.id);
    try {
      logger.info(`[cron] Running job: ${job.name} (${job.id})`);
      const raw = await this.executeHandler(job.id, job.prompt);
      const result = typeof raw === "string" ? { output: raw } : raw;
      job.lastRun = new Date().toISOString();
      job.lastResult = result.output.slice(0, 500);
      if (result.reportPath) job.lastReportPath = result.reportPath;
      this.saveJobs();
    } catch (e) {
      logger.error(`[cron] Job failed: ${job.name}:`, (e as Error).message);
      job.lastRun = new Date().toISOString();
      job.lastResult = `ERROR: ${(e as Error).message}`;
      this.saveJobs();
    } finally {
      this.running.delete(job.id);
    }
  }

  create(name: string, schedule: string, prompt: string, systemJob?: boolean): CronJob {
    if (prompt.length > 5000) {
      throw new Error("Cron job prompt too long (max 5000 characters)");
    }
    if (!schedule || schedule.trim().length === 0) {
      throw new Error("Schedule is required");
    }
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
    Object.assign(job, updates, { id }); // don't let id be overwritten
    this.saveJobs();
    // Reschedule if schedule changed or was re-enabled
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
    if (deleted) this.saveJobs();
    return deleted;
  }

  toggle(id: string): CronJob | null {
    const job = this.jobs.get(id);
    if (!job) return null;
    job.enabled = !job.enabled;
    if (job.enabled) this.scheduleJob(job);
    else {
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

  getSettings(): CronSettings {
    return { ...this.settings };
  }

  updateSettings(updates: Partial<CronSettings>): void {
    this.settings = { ...this.settings, ...updates };
    writeFileSync(this.settingsFile, JSON.stringify(this.settings, null, 2), "utf-8");
    if (this.settings.enabled) this.start();
    else this.stop();
  }
}

// ── Tool Exports ──

export function createCronTools(cron: CronService): ToolDefinition[] {
  return [
    {
      name: "mission_schedule_list",
      description: "List all scheduled missions",
      parameters: { type: "object", properties: {} },
      async execute() {
        const jobs = cron.list();
        if (jobs.length === 0) return { content: "No scheduled jobs." };
        const list = jobs.map(j =>
          `• ${j.name} [${j.id}] — ${j.schedule} — ${j.enabled ? "✅ enabled" : "⏸️ disabled"}${j.lastRun ? ` — last run: ${j.lastRun}` : ""}`
        ).join("\n");
        return { content: list };
      },
    },
    {
      name: "mission_schedule_create",
      description: "Schedule a recurring mission. Schedule can be an interval ('5m', '1h', '30s') or cron expression ('*/5 * * * *'). Prompt is what the agent will execute each run. If a job with the same name exists, it will be updated rather than duplicated.",
      parameters: {
        type: "object",
        properties: {
          name: { type: "string", description: "Job name" },
          schedule: { type: "string", description: "Cron expression or interval (e.g., '5m', '1h', '*/30 * * * *')" },
          prompt: { type: "string", description: "The prompt/instruction to execute each run" },
        },
        required: ["name", "schedule", "prompt"],
      },
      async execute(args) {
        const job = cron.create(String(args.name), String(args.schedule), String(args.prompt));
        return { content: `Created job "${job.name}" (${job.id}) — runs every ${job.schedule}` };
      },
    },
    {
      name: "mission_schedule_delete",
      description: "Delete a scheduled mission by ID",
      parameters: {
        type: "object",
        properties: { id: { type: "string", description: "Job ID" } },
        required: ["id"],
      },
      async execute(args) {
        const deleted = cron.delete(String(args.id));
        return { content: deleted ? "Job deleted." : "Job not found." };
      },
    },
    {
      name: "mission_schedule_update",
      description: "Update an existing scheduled mission. Provide the id (use mission_schedule_list to find it) and any fields to change: name, schedule, or prompt. Other fields stay the same.",
      parameters: {
        type: "object",
        properties: {
          id: { type: "string", description: "Job ID (from mission_schedule_list)" },
          name: { type: "string", description: "New name (optional)" },
          schedule: { type: "string", description: "New cron expression or interval (optional)" },
          prompt: { type: "string", description: "New prompt that the agent will execute each run (optional)" },
        },
        required: ["id"],
      },
      async execute(args) {
        const updates: Record<string, string> = {};
        if (typeof args.name === "string") updates.name = args.name;
        if (typeof args.schedule === "string") updates.schedule = args.schedule;
        if (typeof args.prompt === "string") updates.prompt = args.prompt;
        if (Object.keys(updates).length === 0) {
          return { content: "No fields to update. Provide name, schedule, or prompt.", isError: true };
        }
        const job = cron.update(String(args.id), updates);
        if (!job) return { content: `Job "${args.id}" not found.`, isError: true };
        const changed = Object.keys(updates).join(", ");
        return { content: `Updated mission "${job.name}" (${changed}).` };
      },
    },
    {
      name: "mission_schedule_toggle",
      description: "Enable or disable a scheduled mission",
      parameters: {
        type: "object",
        properties: { id: { type: "string", description: "Job ID" } },
        required: ["id"],
      },
      async execute(args) {
        const job = cron.toggle(String(args.id));
        if (!job) return { content: "Job not found." };
        return { content: `Job "${job.name}" is now ${job.enabled ? "enabled" : "disabled"}.` };
      },
    },
    {
      name: "mission_schedule_reports",
      description: "List or read saved reports for a scheduled mission. Without read_latest, lists all reports. With read_latest, returns the most recent report content.",
      parameters: {
        type: "object",
        properties: {
          id: { type: "string", description: "Job ID (optional — if omitted, searches by name)" },
          name: { type: "string", description: "Job name to search (partial match)" },
          read_latest: { type: "boolean", description: "If true, return the full content of the latest report" },
        },
      },
      async execute(args) {
        // Find the job
        let job: CronJob | null = null;
        if (args.id) {
          job = cron.get(String(args.id));
        } else if (args.name) {
          const needle = String(args.name).toLowerCase();
          job = cron.list().find(j => j.name.toLowerCase().includes(needle)) || null;
        }
        if (!job) return { content: "No matching job found. Use mission_schedule_list to see all missions." };

        const reportsDir = join(cron["dataDir"], "cron", "reports", job.id);
        if (!existsSync(reportsDir)) return { content: `Job "${job.name}" has no saved reports yet.` };

        const files = readdirSync(reportsDir).filter(f => f.endsWith(".md")).sort();
        if (files.length === 0) return { content: `Job "${job.name}" has no saved reports yet.` };

        if (args.read_latest) {
          const latest = files[files.length - 1];
          const content = readFileSync(join(reportsDir, latest), "utf-8");
          return { content: `## Latest report: ${latest}\n\n${content}` };
        }

        const listing = files.map((f, i) => `${i + 1}. ${f}`).join("\n");
        return { content: `## ${job.name} — ${files.length} reports\n\nReport dir: ${reportsDir}\nWorkspace: workspace/missions/${job.name.toLowerCase().replace(/[^a-z0-9]+/g, "-")}/\n\n${listing}` };
      },
    },
  ];
}
