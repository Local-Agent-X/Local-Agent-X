/**
 * Agent-facing tools that wrap the CronService.
 *
 * Tools registered here are exposed to the model via the tool registry and
 * enable scheduling/inspection of recurring missions from a chat.
 */

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type { CronService, CronJob } from "../cron-service.js";
import type { ToolDefinition } from "../types.js";

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
