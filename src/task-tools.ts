import { randomUUID } from "node:crypto";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ToolDefinition, ToolResult } from "./types.js";

interface Task {
  id: string;
  description: string;
  status: "pending" | "in_progress" | "completed" | "failed";
  parent_id?: string;
  output?: string;
  created_at: string;
  updated_at: string;
}

const TASKS_PATH = join(homedir(), ".lax", "tasks.json");
const STATUS_ICON: Record<Task["status"], string> =
  { pending: "\u23F3", in_progress: "\uD83D\uDD04", completed: "\u2705", failed: "\u274C" };
const VALID_STATUSES = new Set(["pending", "in_progress", "completed", "failed"]);

function loadTasks(): Map<string, Task> {
  try {
    const data = JSON.parse(readFileSync(TASKS_PATH, "utf-8")) as Task[];
    return new Map(data.map((t) => [t.id, t]));
  } catch { return new Map(); }
}

function saveTasks(tasks: Map<string, Task>): void {
  mkdirSync(join(homedir(), ".lax"), { recursive: true });
  writeFileSync(TASKS_PATH, JSON.stringify([...tasks.values()], null, 2), "utf-8");
}

function now(): string { return new Date().toISOString(); }

const taskCreate: ToolDefinition = {
  name: "task_create",
  description:
    'Create a task to track work progress. Example: description="Build the login page", parent_id="abc-123" for subtasks.',
  parameters: {
    type: "object",
    properties: {
      description: { type: "string", description: "What the task is about" },
      parent_id: { type: "string", description: "Parent task ID for subtasks" },
    },
    required: ["description"],
  },
  async execute(args: Record<string, unknown>): Promise<ToolResult> {
    const description = args.description as string;
    if (!description) return { content: "Missing required param: description", isError: true };
    const tasks = loadTasks();
    const parentId = args.parent_id as string | undefined;
    if (parentId && !tasks.has(parentId))
      return { content: `Parent task ${parentId} not found`, isError: true };
    const id = randomUUID();
    const ts = now();
    tasks.set(id, { id, description, status: "pending", parent_id: parentId, created_at: ts, updated_at: ts });
    saveTasks(tasks);
    return { content: `Task created: ${id}\nDescription: ${description}`, metadata: { id } };
  },
};

const taskUpdate: ToolDefinition = {
  name: "task_update",
  description:
    'Update a task status or add output. Example: id="abc-123", status="completed", output="Login page built and tested."',
  parameters: {
    type: "object",
    properties: {
      id: { type: "string", description: "Task ID" },
      status: { type: "string", enum: ["pending", "in_progress", "completed", "failed"] },
      output: { type: "string", description: "Task output or result notes" },
    },
    required: ["id"],
  },
  async execute(args: Record<string, unknown>): Promise<ToolResult> {
    const tasks = loadTasks();
    const task = tasks.get(args.id as string);
    if (!task) return { content: `Task ${args.id} not found`, isError: true };
    if (args.status) {
      if (!VALID_STATUSES.has(args.status as string))
        return { content: `Invalid status: ${args.status}`, isError: true };
      task.status = args.status as Task["status"];
    }
    if (args.output !== undefined) task.output = args.output as string;
    task.updated_at = now();
    tasks.set(task.id, task);
    saveTasks(tasks);
    return { content: `Task ${task.id} updated — status: ${task.status}` };
  },
};

const taskList: ToolDefinition = {
  name: "task_list",
  description: "List all tasks, optionally filtered by status or parent task.",
  parameters: {
    type: "object",
    properties: {
      status: { type: "string", enum: ["pending", "in_progress", "completed", "failed"] },
      parent_id: { type: "string", description: "Filter subtasks of a parent" },
    },
  },
  async execute(args: Record<string, unknown>): Promise<ToolResult> {
    let items = [...loadTasks().values()];
    if (args.status) items = items.filter((t) => t.status === args.status);
    if (args.parent_id) items = items.filter((t) => t.parent_id === args.parent_id);
    if (items.length === 0) return { content: "No tasks found." };
    const counts: Record<string, number> = {};
    for (const t of items) counts[t.status] = (counts[t.status] || 0) + 1;
    const summary = Object.entries(counts).map(([s, n]) => `${n} ${s}`).join(", ");
    const lines = items.map(
      (t, i) => `${i + 1}. ${STATUS_ICON[t.status]} [${t.status}] ${t.description} (${t.id.slice(0, 8)})`
    );
    return { content: `${items.length} tasks (${summary})\n\n${lines.join("\n")}` };
  },
};

const taskGet: ToolDefinition = {
  name: "task_get",
  description: "Get details for a specific task by ID.",
  parameters: {
    type: "object",
    properties: { id: { type: "string", description: "Task ID" } },
    required: ["id"],
  },
  async execute(args: Record<string, unknown>): Promise<ToolResult> {
    const tasks = loadTasks();
    const task = tasks.get(args.id as string);
    if (!task) return { content: `Task ${args.id} not found`, isError: true };
    const subs = [...tasks.values()].filter((t) => t.parent_id === task.id);
    const detail = [
      `ID:          ${task.id}`,
      `Description: ${task.description}`,
      `Status:      ${STATUS_ICON[task.status]} ${task.status}`,
      task.parent_id ? `Parent:      ${task.parent_id}` : null,
      task.output ? `Output:      ${task.output}` : null,
      `Created:     ${task.created_at}`,
      `Updated:     ${task.updated_at}`,
      subs.length ? `Subtasks:    ${subs.length}` : null,
    ].filter(Boolean);
    return { content: detail.join("\n") };
  },
};

export const taskTools: ToolDefinition[] = [taskCreate, taskUpdate, taskList, taskGet];
