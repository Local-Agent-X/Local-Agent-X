/**
 * Cron Service for Open Agent X
 *
 * Runs scheduled jobs (prompts) at defined intervals.
 * Jobs persist to disk so they survive restarts.
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
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
  createdAt: string;
}

interface CronSettings {
  enabled: boolean;
  maxConcurrent: number;
}

type ExecuteHandler = (jobId: string, prompt: string) => Promise<string>;

// Parse simple interval strings like "5m", "1h", "30s"
function parseInterval(schedule: string): number | null {
  const match = schedule.match(/^(\d+)(s|m|h|d)$/);
  if (!match) return null;
  const [, num, unit] = match;
  const multipliers: Record<string, number> = { s: 1000, m: 60000, h: 3600000, d: 86400000 };
  return parseInt(num) * (multipliers[unit] || 60000);
}

// Simple cron expression parser (minute hour dom month dow)
function getNextCronMs(schedule: string): number | null {
  const parts = schedule.trim().split(/\s+/);
  if (parts.length !== 5) return null;
  // For simplicity, support basic patterns: "*/N * * * *" (every N minutes)
  const minPart = parts[0];
  if (minPart.startsWith("*/")) {
    const interval = parseInt(minPart.slice(2));
    if (!isNaN(interval)) return interval * 60000;
  }
  // Default: run every hour for unrecognized patterns
  return 3600000;
}

function getIntervalMs(schedule: string): number {
  const ms = parseInterval(schedule) || getNextCronMs(schedule) || 3600000;
  if (ms < 60000) return 60000; // minimum 1 minute
  return ms;
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
    if (!existsSync(cronDir)) mkdirSync(cronDir, { recursive: true });
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
    for (const [id, timer] of this.timers) {
      clearInterval(timer);
    }
    this.timers.clear();
  }

  private scheduleJob(job: CronJob): void {
    // Clear existing timer
    const existing = this.timers.get(job.id);
    if (existing) clearInterval(existing);

    const intervalMs = getIntervalMs(job.schedule);
    const timer = setInterval(() => this.executeJob(job), intervalMs);
    this.timers.set(job.id, timer);
  }

  private async executeJob(job: CronJob): Promise<void> {
    if (!this.executeHandler) return;
    if (this.running.size >= this.settings.maxConcurrent) return;
    if (this.running.has(job.id)) return;

    this.running.add(job.id);
    try {
      console.log(`[cron] Running job: ${job.name} (${job.id})`);
      const result = await this.executeHandler(job.id, job.prompt);
      job.lastRun = new Date().toISOString();
      job.lastResult = result.slice(0, 500);
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
      name: "cron_list",
      description: "List all scheduled cron jobs",
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
      name: "cron_create",
      description: "Create a new scheduled job. Schedule can be a cron expression ('*/5 * * * *') or interval ('5m', '1h', '30s'). Prompt is what the agent will execute each run.",
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
      name: "cron_delete",
      description: "Delete a scheduled job by ID",
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
      name: "cron_toggle",
      description: "Enable or disable a scheduled job",
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
  ];
}
