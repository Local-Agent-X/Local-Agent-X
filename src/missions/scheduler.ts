/**
 * Mission Scheduling — integrates with the cron system to run missions on schedule.
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import type { Mission } from "../missions.js";
import type { ToolDefinition } from "../types.js";

export interface ScheduledMission {
  id: string;
  missionName: string;
  cronExpression: string;
  args: Record<string, unknown>;
  enabled: boolean;
  lastRun?: number;
  nextRun?: number;
  createdAt: number;
}

const SCHEDULES_PATH = join(homedir(), ".sax", "mission-schedules.json");

function ensureDir(): void {
  const dir = join(homedir(), ".sax");
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
}

export function loadSchedules(): ScheduledMission[] {
  if (existsSync(SCHEDULES_PATH)) {
    try { return JSON.parse(readFileSync(SCHEDULES_PATH, "utf-8")); } catch {}
  }
  return [];
}

export function saveSchedules(schedules: ScheduledMission[]): void {
  ensureDir();
  writeFileSync(SCHEDULES_PATH, JSON.stringify(schedules, null, 2), "utf-8");
}

function generateId(): string {
  return `sched_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

function parseCronField(field: string, min: number, max: number): number[] {
  if (field === "*") return Array.from({ length: max - min + 1 }, (_, i) => i + min);
  if (field.includes("/")) {
    const [, step] = field.split("/");
    const s = parseInt(step, 10);
    return Array.from({ length: max - min + 1 }, (_, i) => i + min).filter(v => v % s === 0);
  }
  if (field.includes(",")) return field.split(",").map(Number);
  if (field.includes("-")) {
    const [a, b] = field.split("-").map(Number);
    return Array.from({ length: b - a + 1 }, (_, i) => i + a);
  }
  return [parseInt(field, 10)];
}

export function getNextCronRun(cron: string, after: Date = new Date()): Date {
  const parts = cron.trim().split(/\s+/);
  if (parts.length !== 5) throw new Error("Invalid cron expression: expected 5 fields");

  const [minField, hourField, domField, monField, dowField] = parts;
  const minutes = parseCronField(minField, 0, 59);
  const hours = parseCronField(hourField, 0, 23);
  const doms = parseCronField(domField, 1, 31);
  const months = parseCronField(monField, 1, 12);
  const dows = parseCronField(dowField, 0, 6);

  const candidate = new Date(after.getTime() + 60_000);
  candidate.setSeconds(0, 0);

  for (let i = 0; i < 525960; i++) {
    if (
      minutes.includes(candidate.getMinutes()) &&
      hours.includes(candidate.getHours()) &&
      doms.includes(candidate.getDate()) &&
      months.includes(candidate.getMonth() + 1) &&
      dows.includes(candidate.getDay())
    ) {
      return candidate;
    }
    candidate.setTime(candidate.getTime() + 60_000);
  }
  throw new Error("Could not find next cron run within one year");
}

export function scheduleMission(
  missionName: string,
  cronExpression: string,
  args: Record<string, unknown> = {}
): ScheduledMission {
  const schedules = loadSchedules();
  const now = Date.now();
  const entry: ScheduledMission = {
    id: generateId(),
    missionName,
    cronExpression,
    args,
    enabled: true,
    createdAt: now,
    nextRun: getNextCronRun(cronExpression).getTime(),
  };
  schedules.push(entry);
  saveSchedules(schedules);
  return entry;
}

export function unscheduleMission(id: string): boolean {
  const schedules = loadSchedules();
  const idx = schedules.findIndex(s => s.id === id);
  if (idx === -1) return false;
  schedules.splice(idx, 1);
  saveSchedules(schedules);
  return true;
}

export function toggleSchedule(id: string, enabled: boolean): ScheduledMission | null {
  const schedules = loadSchedules();
  const entry = schedules.find(s => s.id === id);
  if (!entry) return null;
  entry.enabled = enabled;
  saveSchedules(schedules);
  return entry;
}

export function getDueMissions(): ScheduledMission[] {
  const now = Date.now();
  return loadSchedules().filter(s => s.enabled && s.nextRun && s.nextRun <= now);
}

export function markMissionRan(id: string): void {
  const schedules = loadSchedules();
  const entry = schedules.find(s => s.id === id);
  if (!entry) return;
  entry.lastRun = Date.now();
  entry.nextRun = getNextCronRun(entry.cronExpression).getTime();
  saveSchedules(schedules);
}

export function createSchedulerTools(): ToolDefinition[] {
  return [
    {
      name: "mission_schedule",
      description: "Schedule a mission to run on a cron schedule.",
      parameters: {
        type: "object",
        properties: {
          missionName: { type: "string", description: "Name of the mission to schedule" },
          cron: { type: "string", description: "Cron expression (e.g., '0 9 * * 1' for Mon 9am)" },
          args: { type: "object", description: "Arguments to pass to the mission" },
        },
        required: ["missionName", "cron"],
      },
      async execute(args) {
        try {
          const entry = scheduleMission(
            String(args.missionName),
            String(args.cron),
            (args.args as Record<string, unknown>) ?? {}
          );
          return {
            content: `Scheduled "${entry.missionName}" (${entry.cronExpression}). ID: ${entry.id}\nNext run: ${new Date(entry.nextRun!).toISOString()}`,
          };
        } catch (e: any) {
          return { content: e.message, isError: true };
        }
      },
    },
    {
      name: "mission_unschedule",
      description: "Remove a scheduled mission.",
      parameters: {
        type: "object",
        properties: { id: { type: "string", description: "Schedule ID" } },
        required: ["id"],
      },
      async execute(args) {
        return {
          content: unscheduleMission(String(args.id))
            ? `Removed schedule ${args.id}.`
            : `Schedule "${args.id}" not found.`,
        };
      },
    },
    {
      name: "mission_schedules_list",
      description: "List all scheduled missions.",
      parameters: { type: "object", properties: {} },
      async execute() {
        const schedules = loadSchedules();
        if (schedules.length === 0) return { content: "No scheduled missions." };
        const list = schedules.map(s =>
          `• **${s.missionName}** [${s.id}] — \`${s.cronExpression}\` ${s.enabled ? "✅" : "⏸️"}\n  Next: ${s.nextRun ? new Date(s.nextRun).toISOString() : "N/A"} | Last: ${s.lastRun ? new Date(s.lastRun).toISOString() : "never"}`
        ).join("\n\n");
        return { content: `Scheduled missions:\n\n${list}` };
      },
    },
  ];
}
