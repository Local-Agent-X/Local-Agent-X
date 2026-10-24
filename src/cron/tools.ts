/**
 * Agent-facing tools that wrap the CronService.
 *
 * Tools registered here are exposed to the model via the tool registry and
 * enable scheduling/inspection of recurring missions from a chat.
 */

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type { CronService, CronJob } from "./cron-service.js";
import type { ToolDefinition, ToolResult } from "../types.js";
import { blocked } from "../tools/result-helpers.js";
import { agentMissionRefusal } from "./job-authority.js";
import { grantSecretPlanFromChat, SECRET_PLAN_PARAMETER } from "./secret-plan-card.js";

const refused = (reason: string): ToolResult => blocked(reason, {
  layer: "job-authority",
  recovery: "Only the user can make this change, on the Missions page. Tell them exactly what to change; to add a separate mission instead, create one under a new name.",
});

/**
 * A mission by its id, or by its exact name when one mission has it. A
 * scheduled run is told its own mission's name ("then delete this mission"),
 * and passing that to an id-only lookup answered "Job not found": the reminder
 * stayed scheduled, and the run reported it had cleaned up (2026-10-24).
 */
function findJob(cron: CronService, ref: unknown): CronJob | null {
  const key = String(ref ?? "").trim();
  if (!key) return null;
  const byId = cron.get(key);
  if (byId) return byId;
  const named = cron.list().filter((j) => j.name.toLowerCase() === key.toLowerCase());
  return named.length === 1 ? named[0] : null;
}

/** A miss is an error, so neither the model nor the outcome check reads it as done. */
const notFound = (ref: unknown): ToolResult => ({
  content: `No mission with id or name "${String(ref ?? "")}". mission_schedule_list shows each mission's id and name.`,
  isError: true,
});

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
      compactDescription: "Schedule a recurring mission: `schedule` is an interval ('5m', '1h') or cron ('*/5 * * * *'); `prompt` runs each time; same name updates the job. Each run is a full billed session — pick the longest interval that works.",
      description: "Schedule a recurring mission. Schedule can be an interval ('5m', '1h', '30s') or cron expression ('*/5 * * * *'). Prompt is what the agent will execute each run. If a job with the same name exists, it will be updated rather than duplicated. Each run is a fresh full-context session billed at the job's model — pick the longest interval that still meets the need, and reserve tight intervals (under ~15m) for genuinely time-sensitive missions.",
      parameters: {
        type: "object",
        properties: {
          name: { type: "string", description: "Job name" },
          schedule: { type: "string", description: "Cron expression or interval (e.g., '5m', '1h', '*/30 * * * *')" },
          prompt: { type: "string", description: "The prompt/instruction to execute each run" },
          timezone: { type: "string", description: "Optional IANA timezone the cron expression runs in (e.g. 'America/New_York', 'Europe/London'). Omit for the server's local time. Ignored for fixed intervals. If the user gives a clock time (e.g. '9am daily'), set this to their timezone so it fires at their local time." },
          secrets: SECRET_PLAN_PARAMETER,
        },
        required: ["name", "schedule", "prompt"],
      },
      async execute(args) {
        const name = String(args.name);
        const schedule = String(args.schedule);
        const prompt = String(args.prompt);
        // A name already in use rewrites that mission's schedule and prompt (CronService.create).
        const refusal = agentMissionRefusal({ schedule, prompt }, cron.list().find((j) => j.name === name));
        if (refusal) return refused(refusal);
        const tz = typeof args.timezone === "string" && args.timezone.trim() ? args.timezone.trim() : undefined;
        const job = cron.create(name, schedule, prompt, undefined, { tz });
        const keys = await grantSecretPlanFromChat(cron, job, args.secrets, args, "mission_schedule_create");
        return { content: `Created job "${job.name}" (${job.id}) — runs every ${job.schedule}${job.tz ? ` (${job.tz})` : ""}${keys}` };
      },
    },
    {
      name: "mission_schedule_delete",
      description: "Delete a scheduled mission by its ID or exact name",
      parameters: {
        type: "object",
        properties: { id: { type: "string", description: "Job ID or exact mission name" } },
        required: ["id"],
      },
      async execute(args) {
        const job = findJob(cron, args.id);
        if (!job || !(await cron.delete(job.id))) return notFound(args.id);
        return { content: `Deleted mission "${job.name}" (${job.id}).` };
      },
    },
    {
      name: "mission_schedule_update",
      description: "Update an existing scheduled mission. Provide the id (use mission_schedule_list to find it) and any fields to change: name, schedule, prompt, timezone, or secrets (saved keys the job may send, each approved by the user). Other fields stay the same. When changing the schedule, remember each run is a fresh full-context session billed at the job's model — prefer the longest interval that still meets the need.",
      parameters: {
        type: "object",
        properties: {
          id: { type: "string", description: "Job ID or exact mission name (from mission_schedule_list)" },
          name: { type: "string", description: "New name (optional)" },
          schedule: { type: "string", description: "New cron expression or interval (optional)" },
          prompt: { type: "string", description: "New prompt that the agent will execute each run (optional)" },
          timezone: { type: "string", description: "New IANA timezone for the cron expression (optional, e.g. 'America/New_York'). Pass an empty string to clear it back to server local time." },
          secrets: SECRET_PLAN_PARAMETER,
        },
        required: ["id"],
      },
      async execute(args) {
        const updates: Record<string, string> = {};
        if (typeof args.name === "string") updates.name = args.name;
        if (typeof args.schedule === "string") updates.schedule = args.schedule;
        if (typeof args.prompt === "string") updates.prompt = args.prompt;
        if (typeof args.timezone === "string") updates.tz = args.timezone.trim();
        if (Object.keys(updates).length === 0 && args.secrets === undefined) {
          return { content: "No fields to update. Provide name, schedule, prompt, timezone, or secrets.", isError: true };
        }
        const found = findJob(cron, args.id);
        if (!found) return notFound(args.id);
        const refusal = agentMissionRefusal(updates, found);
        if (refusal) return refused(refusal);
        let job: CronJob | null;
        try {
          job = Object.keys(updates).length > 0 ? cron.update(found.id, updates) : found;
        } catch (e) {
          return { content: (e as Error).message, isError: true };
        }
        if (!job) return notFound(args.id);
        const keys = await grantSecretPlanFromChat(cron, job, args.secrets, args, "mission_schedule_update");
        const changed = Object.keys(updates).map(k => k === "tz" ? "timezone" : k).join(", ");
        return { content: `Updated mission "${job.name}"${changed ? ` (${changed})` : ""}.${keys}` };
      },
    },
    {
      name: "mission_schedule_toggle",
      description: "Enable or disable a scheduled mission",
      parameters: {
        type: "object",
        properties: { id: { type: "string", description: "Job ID or exact mission name" } },
        required: ["id"],
      },
      async execute(args) {
        const found = findJob(cron, args.id);
        const job = found ? cron.toggle(found.id) : null;
        if (!job) return notFound(args.id);
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
        let job: CronJob | null = null;
        if (args.id) {
          job = cron.get(String(args.id));
        } else if (args.name) {
          const needle = String(args.name).toLowerCase();
          job = cron.list().find(j => j.name.toLowerCase().includes(needle)) || null;
        }
        if (!job) return { content: "No matching job found. Use mission_schedule_list to see all missions." };

        const reportsDir = join(cron.getDataDir(), "cron", "reports", job.id);
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
