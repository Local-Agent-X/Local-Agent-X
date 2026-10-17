import { randomUUID } from "node:crypto";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { getLaxDir } from "../lax-data-dir.js";
import type { ToolDefinition, ToolResult } from "../types.js";
import { sessionIdOf } from "../tool-execution/internal-args.js";

interface Task {
  id: string;
  description: string;
  status: "pending" | "in_progress" | "completed" | "failed";
  parent_id?: string;
  output?: string;
  /** Session that created the task. Lets the open-steps completion gate scope
   *  "unfinished work" to the conversation that declared it, instead of every
   *  task ever synced from any session or device. Absent on legacy/pre-scoping
   *  tasks — those simply never match a live session, so they never nag. */
  session_id?: string;
  created_at: string;
  updated_at: string;
}

const TASKS_PATH = join(getLaxDir(), "tasks.json");
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
  mkdirSync(getLaxDir(), { recursive: true });
  writeFileSync(TASKS_PATH, JSON.stringify([...tasks.values()], null, 2), "utf-8");
}

function now(): string { return new Date().toISOString(); }

/** The task `id` names: an exact id, else the one task whose id starts with
 *  it — task_list prints the first 8 characters of a generated UUID, and a
 *  model that passes those back must land on that task, not mint a new one. */
function resolveTask(tasks: Map<string, Task>, id: string): { task: Task } | { error: string } {
  const exact = tasks.get(id);
  if (exact) return { task: exact };
  const matches = [...tasks.values()].filter((t) => t.id.startsWith(id));
  if (matches.length === 1) return { task: matches[0] };
  if (matches.length === 0) return { error: `No task with id "${id}". Use task_list to see the ids, or task_create to add it.` };
  return { error: `"${id}" matches ${matches.length} tasks: ${matches.map((t) => t.id).join(", ")}. Pass the full id.` };
}

const taskCreate: ToolDefinition = {
  name: "task_create",
  description:
    'Create a task to track work progress. Example: description="Build the login page". ' +
    'You may pass your own id="setup" to reference it later (an id already in use is an error); otherwise one is assigned. ' +
    'parent_id links a subtask to a parent.',
  parameters: {
    type: "object",
    properties: {
      description: { type: "string", description: "What the task is about" },
      id: { type: "string", description: "Optional caller-chosen id to reference this task later" },
      parent_id: { type: "string", description: "Parent task ID for subtasks" },
    },
    required: ["description"],
  },
  async execute(args: Record<string, unknown>): Promise<ToolResult> {
    const description = args.description as string;
    if (!description) return { content: "Missing required param: description", isError: true };
    const tasks = loadTasks();
    // Honor a caller-chosen id — models name their own task ids (a universal
    // to-do-list prior) and then reference them. Fighting that with a
    // server-only random id made every later parent_id / update reference miss
    // ("Parent task X not found" × N), and weak models derail into explaining the
    // errors instead of finishing (live failure 2026-07-02, food-truck preflight).
    // A taken id is an error, not a silent swap: a swap left the model holding a
    // name that pointed at someone else's task.
    const requestedId = typeof args.id === "string" && args.id.trim() ? args.id.trim() : undefined;
    const taken = requestedId ? tasks.get(requestedId) : undefined;
    if (taken) {
      return { content: `Task id "${requestedId}" is already taken by "${taken.description}" (${taken.status}). Use task_update to change that task, or pick another id.`, isError: true };
    }
    const id = requestedId ?? randomUUID();
    // A missing parent is coerced to a root task, never an error: the hierarchy
    // is advisory (the open-steps gate scopes by session + status, not by tree),
    // so a dangling parent must not block the actual work.
    const parentId = args.parent_id as string | undefined;
    const parent = parentId && tasks.has(parentId) ? parentId : undefined;
    const ts = now();
    const sessionId = sessionIdOf(args);
    tasks.set(id, { id, description, status: "pending", parent_id: parent, session_id: sessionId, created_at: ts, updated_at: ts });
    saveTasks(tasks);
    const note = parentId && !parent ? ` (parent ${parentId} not found — created as a root task)` : "";
    return { content: `Task created: ${id}\nDescription: ${description}${note}`, metadata: { id } };
  },
};

const taskUpdate: ToolDefinition = {
  name: "task_update",
  description:
    'Update a task status or add output. Example: id="abc-123", status="completed", output="Login page built and tested." ' +
    'The id may be the prefix task_list prints; an id that matches no task (or several) is an error — task_create makes new tasks.',
  parameters: {
    type: "object",
    properties: {
      id: { type: "string", description: "Task ID, or a unique prefix of it (as task_list prints)" },
      status: { type: "string", enum: ["pending", "in_progress", "completed", "failed"] },
      output: { type: "string", description: "Task output or result notes" },
    },
    required: ["id"],
  },
  async execute(args: Record<string, unknown>): Promise<ToolResult> {
    const id = args.id as string;
    if (!id) return { content: "Missing required param: id", isError: true };
    if (args.status && !VALID_STATUSES.has(args.status as string))
      return { content: `Invalid status: ${args.status}`, isError: true };
    const tasks = loadTasks();
    // No upsert: task_list prints 8-character ids, and an update by one of
    // those silently created a second task under the prefix while the real one
    // stayed open (and the open-steps gate kept nagging about it).
    const found = resolveTask(tasks, id);
    if ("error" in found) return { content: found.error, isError: true };
    const { task } = found;
    if (args.status) task.status = args.status as Task["status"];
    if (args.output !== undefined) task.output = args.output as string;
    task.updated_at = now();
    tasks.set(task.id, task);
    saveTasks(tasks);
    return { content: `Task ${task.id} updated — status: ${task.status}` };
  },
};

const taskList: ToolDefinition = {
  name: "task_list",
  description:
    "List tasks from the current session, optionally filtered by status or parent task. " +
    "Set all_sessions=true only when the user explicitly asks for the global task ledger.",
  parameters: {
    type: "object",
    properties: {
      status: { type: "string", enum: ["pending", "in_progress", "completed", "failed"] },
      parent_id: { type: "string", description: "Filter subtasks of a parent" },
      all_sessions: { type: "boolean", description: "Include every session's tasks (default false)" },
    },
  },
  async execute(args: Record<string, unknown>): Promise<ToolResult> {
    let items = [...loadTasks().values()];
    const sessionId = (sessionIdOf(args) ?? "").trim();
    if (sessionId && args.all_sessions !== true) {
      items = items.filter((t) => t.session_id === sessionId);
    }
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
  description: "Get details for a specific task by ID (or the unique prefix task_list prints).",
  parameters: {
    type: "object",
    properties: { id: { type: "string", description: "Task ID, or a unique prefix of it" } },
    required: ["id"],
  },
  async execute(args: Record<string, unknown>): Promise<ToolResult> {
    const tasks = loadTasks();
    const found = resolveTask(tasks, String(args.id ?? ""));
    if ("error" in found) return { content: found.error, isError: true };
    const { task } = found;
    const sessionId = (sessionIdOf(args) ?? "").trim();
    if (sessionId && task.session_id && task.session_id !== sessionId) {
      return { content: `Task ${args.id} not found in this session`, isError: true };
    }
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

/** Open (pending / in_progress) tasks a given session created — the signal the
 *  open-steps completion gate reads to decide whether a turn that's about to end
 *  has left declared work unfinished. Scoped to sessionId so a task from another
 *  conversation or synced device never counts against this one. Returns id +
 *  description so the gate can name the remaining steps in its nudge. */
export function getOpenTasksForSession(sessionId: string): { id: string; description: string }[] {
  if (!sessionId) return [];
  return [...loadTasks().values()]
    .filter((t) => t.session_id === sessionId && (t.status === "pending" || t.status === "in_progress"))
    .map((t) => ({ id: t.id, description: t.description }));
}
