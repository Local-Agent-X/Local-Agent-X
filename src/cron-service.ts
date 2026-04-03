/**
 * Cron Service for Open Agent X
 *
 * Runs scheduled jobs (prompts) at defined intervals.
 * Jobs persist to disk so they survive restarts.
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type { ToolDefinition } from "./types.js";

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
        for (const job of data) this.jobs.set(job.id, job);
      } catch {}
    }
  }

  private saveJobs(): void {
    writeFileSync(this.jobsFile, JSON.stringify([...this.jobs.values()], null, 2), "utf-8");
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
    for (const job of this.jobs.values()) {
      if (job.enabled) this.scheduleJob(job);
    }
    console.log(`[cron] Started with ${this.jobs.size} jobs`);
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
    console.log(`[cron] ${job.name}: next run at ${nextRun.toLocaleString()} (${Math.round(ms / 60000)}m from now)`);
  }

  private async executeJob(job: CronJob): Promise<void> {
    if (!this.executeHandler) return;
    if (this.running.size >= this.settings.maxConcurrent) return;
    if (this.running.has(job.id)) return;

    this.running.add(job.id);
    try {
      console.log(`[cron] Running job: ${job.name} (${job.id})`);
      const raw = await this.executeHandler(job.id, job.prompt);
      const result = typeof raw === "string" ? { output: raw } : raw;
      job.lastRun = new Date().toISOString();
      job.lastResult = result.output.slice(0, 500);
      if (result.reportPath) job.lastReportPath = result.reportPath;
      this.saveJobs();
    } catch (e) {
      console.error(`[cron] Job failed: ${job.name}:`, (e as Error).message);
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

  get(id: string): CronJob | null {
    return this.jobs.get(id) || null;
  }

  list(): CronJob[] {
    return [...this.jobs.values()];
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
      name: "schedule_list",
      description: "List all scheduled missions/jobs",
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
      name: "schedule_create",
      description: "Schedule a recurring mission/task. Schedule can be an interval ('5m', '1h', '30s') or cron expression ('*/5 * * * *'). Prompt is what the agent will execute each run.",
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
      name: "schedule_delete",
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
      name: "schedule_toggle",
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
      name: "schedule_reports",
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
        if (!job) return { content: "No matching job found. Use schedule_list to see all jobs." };

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
