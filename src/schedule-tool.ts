/**
 * Schedule Tools — exposes CronService as agent-callable tools.
 */

import type { CronService, CronJob } from './cron-service.js';
import type { ToolDefinition, ToolResult } from './types.js';

function findJobByName(jobs: CronJob[], name: string): CronJob | undefined {
  return jobs.find(j => j.name === name);
}

function estimateNextRun(job: CronJob): string {
  if (!job.enabled) return 'disabled';
  if (!job.lastRun) return 'pending (first run)';
  return `after ${job.lastRun}`;
}

function formatJob(j: CronJob): string {
  return `${j.name} | schedule: ${j.schedule} | next: ${estimateNextRun(j)} | id: ${j.id}`;
}

export function createScheduleTools(cronService: CronService): ToolDefinition[] {
  return [
    {
      name: 'schedule_list',
      description: 'List all scheduled tasks with their cron expressions and next run times.',
      parameters: { type: 'object', properties: {} },
      async execute(): Promise<ToolResult> {
        try {
          const jobs = cronService.list();
          if (jobs.length === 0) return { content: 'No scheduled tasks.' };
          const lines = jobs.map(formatJob);
          return { content: lines.join('\n'), metadata: { count: jobs.length } };
        } catch (e) {
          return { content: `Failed to list tasks: ${(e as Error).message}`, isError: true };
        }
      },
    },
    {
      name: 'schedule_create',
      description:
        'Create a scheduled task. Example: name="daily-backup", cron="0 2 * * *", task="Back up the workspace folder"',
      parameters: {
        type: 'object',
        properties: {
          name: { type: 'string', description: 'Unique name for the task' },
          cron: { type: 'string', description: 'Cron expression or interval (e.g. "5m", "0 2 * * *")' },
          task: { type: 'string', description: 'What to do when triggered' },
        },
        required: ['name', 'cron', 'task'],
      },
      async execute(args: Record<string, unknown>): Promise<ToolResult> {
        try {
          const name = String(args.name ?? '');
          const cron = String(args.cron ?? '');
          const task = String(args.task ?? '');
          if (!name || !cron || !task) {
            return { content: 'Missing required parameter (name, cron, or task).', isError: true };
          }
          const job = cronService.create(name, cron, task);
          return {
            content: `Created task "${job.name}" (${job.id}) with schedule: ${job.schedule}`,
            metadata: { id: job.id },
          };
        } catch (e) {
          return { content: `Failed to create task: ${(e as Error).message}`, isError: true };
        }
      },
    },
    {
      name: 'schedule_delete',
      description: 'Delete a scheduled task by name.',
      parameters: {
        type: 'object',
        properties: {
          name: { type: 'string', description: 'Name of the task to delete' },
        },
        required: ['name'],
      },
      async execute(args: Record<string, unknown>): Promise<ToolResult> {
        try {
          const name = String(args.name ?? '');
          if (!name) return { content: 'Name is required.', isError: true };
          const job = findJobByName(cronService.list(), name);
          if (!job) return { content: `No task found with name "${name}".`, isError: true };
          const deleted = cronService.delete(job.id);
          return { content: deleted ? `Deleted task "${name}".` : `Failed to delete "${name}".` };
        } catch (e) {
          return { content: `Failed to delete task: ${(e as Error).message}`, isError: true };
        }
      },
    },
  ];
}
