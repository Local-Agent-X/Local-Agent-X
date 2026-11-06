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

function loadTasks(): Task[] {
  try {
    return JSON.parse(readFileSync(TASKS_PATH, "utf-8")) as Task[];
  } catch { return []; }
}

function saveTasks(tasks: Task[]): void {
  mkdirSync(getLaxDir(), { recursive: true });
  writeFileSync(TASKS_PATH, JSON.stringify(tasks, null, 2), "utf-8");
}

function now(): string { return new Date().toISOString(); }

/** The tasks a call can see: its own session's. The store is one file for
 *  every session and device, and a task id is a name the model picks
 *  ("read", "verify"), so two sessions naming the same step must not collide
 *  — a sub-agent once lost its plan to a finished session's "read". A call
 *  with no session (a legacy caller) sees every task, as it always did. */
function inScope(task: Task, sessionId: string): boolean {
  return !sessionId || task.session_id === sessionId;
}

function sessionOf(args: Record<string, unknown>): string {
  return (sessionIdOf(args) ?? "").trim();
}

/** The task `id` names within the session: an exact id, else the one task
 *  whose id starts with it — task_list prints the first 8 characters of a
 *  generated UUID, and a model that passes those back must land on that task,
 *  not mint a new one. */
function resolveTask(tasks: Task[], id: string, sessionId: string): { task: Task } | { error: string } {
  const visible = tasks.filter((t) => inScope(t, sessionId));
  const exact = visible.filter((t) => t.id === id);
  const matches = exact.length ? exact : visible.filter((t) => t.id.startsWith(id));
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
    const sessionId = sessionOf(args);
    // Honor a caller-chosen id — models name their own task ids (a universal
    // to-do-list prior) and then reference them. Fighting that with a
    // server-only random id made every later parent_id / update reference miss
    // ("Parent task X not found" × N), and weak models derail into explaining the
    // errors instead of finishing (live failure 2026-07-02, food-truck preflight).
    // A taken id is an error, not a silent swap: a swap left the model holding a
    // name that pointed at someone else's task.
    const requestedId = typeof args.id === "string" && args.id.trim() ? args.id.trim() : undefined;
    const taken = requestedId ? tasks.find((t) => t.id === requestedId && inScope(t, sessionId)) : undefined;
    if (taken) {
      return { content: `Task id "${requestedId}" is already taken by "${taken.description}" (${taken.status}). Use task_update to change that task, or pick another id.`, isError: true };
    }
    const id = requestedId ?? randomUUID();
    // A missing parent is coerced to a root task, never an error: the hierarchy
    // is advisory (the open-steps gate scopes by session + status, not by tree),
    // so a dangling parent must not block the actual work.
    const parentId = args.parent_id as string | undefined;
    const parent = parentId && tasks.some((t) => t.id === parentId && inScope(t, sessionId)) ? parentId : undefined;
    const ts = now();
    tasks.push({ id, description, status: "pending", parent_id: parent, session_id: sessionId || undefined, created_at: ts, updated_at: ts });
    saveTasks(tasks);
    const note = parentId && !parent ? ` (parent ${parentId} not found — created as a root task)` : "";
    return { content: `Task created: ${id}\nDescription: ${description}${note}`, metadata: { id, plan: planOf(tasks, sessionId) } };
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
    const sessionId = sessionOf(args);
    const found = resolveTask(tasks, id, sessionId);
    if ("error" in found) return { content: found.error, isError: true };
    const { task } = found;
    if (args.status) task.status = args.status as Task["status"];
    if (args.output !== undefined) task.output = args.output as string;
    task.updated_at = now();
    saveTasks(tasks);
    return { content: `Task ${task.id} updated — status: ${task.status}`, metadata: { plan: planOf(tasks, sessionId) } };
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
    let items = loadTasks();
    if (args.all_sessions !== true) {
      const sessionId = sessionOf(args);
      items = items.filter((t) => inScope(t, sessionId));
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
    const sessionId = sessionOf(args);
    const found = resolveTask(tasks, String(args.id ?? ""), sessionId);
    if ("error" in found) return { content: found.error, isError: true };
    const { task } = found;
    const subs = tasks.filter((t) => t.parent_id === task.id && inScope(t, sessionId));
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

/** A step as the chat draws it, live under the reply on the desktop and the phone
 *  (metadata.plan; agentxos progress.ts). */
export interface PlanStep { text: string; status: Task["status"] }

const MAX_PLAN_STEPS = 20;

/** The session's steps, in the order they were made: every task tool's result carries
 *  them, so the chat's step list follows the store whichever tool changed it. */
function planOf(tasks: Task[], sessionId: string): PlanStep[] {
  if (!sessionId) return [];
  return tasks.filter((t) => t.session_id === sessionId).slice(-MAX_PLAN_STEPS)
    .map((t) => ({ text: t.description, status: t.status }));
}

function planLine(plan: PlanStep[]): string {
  const done = plan.filter((s) => s.status === "completed").length;
  const current = plan.find((s) => s.status === "in_progress");
  return `Steps: ${done} of ${plan.length} done${current ? `; now: ${current.text}` : ""}.`;
}

/** Complete the in-progress step and start the next pending one. */
function advance(tasks: Task[], sessionId: string): void {
  const mine = tasks.filter((t) => t.session_id === sessionId);
  const current = mine.find((t) => t.status === "in_progress");
  if (current) { current.status = "completed"; current.updated_at = now(); }
  const next = mine.find((t) => t.status === "pending");
  if (next) { next.status = "in_progress"; next.updated_at = now(); }
}

/** The session's whole step list, replaced: the session's earlier steps go. */
function replacePlan(tasks: Task[], sessionId: string, items: unknown[]): Task[] | string {
  if (items.length === 0 || items.length > MAX_PLAN_STEPS) return `items must hold 1 to ${MAX_PLAN_STEPS} steps.`;
  const ts = now();
  const steps: Task[] = [];
  for (const raw of items) {
    const o = (raw ?? {}) as Record<string, unknown>;
    const text = typeof o.content === "string" ? o.content.trim().slice(0, 120) : "";
    const status = typeof o.status === "string" ? o.status : "pending";
    if (!text) return "Every step needs its content.";
    if (!VALID_STATUSES.has(status)) return `Invalid status: ${status}`;
    steps.push({ id: randomUUID(), description: text, status: status as Task["status"], session_id: sessionId, created_at: ts, updated_at: ts });
  }
  return [...tasks.filter((t) => t.session_id !== sessionId), ...steps];
}

const updatePlan: ToolDefinition = {
  name: "update_plan",
  compactDescription: "The user's live step list for multi-step work: items = the whole list (replaces it), or advance=true to finish the current step and start the next.",
  description:
    "Keep the step list the user sees under your reply, on the desktop and the phone, for work with several steps (editing files, " +
    "running commands, anything that takes more than a couple of tool calls). First call: items = the whole plan in order, short " +
    "imperative steps, the one you are starting 'in_progress', the rest 'pending'. Then advance=true alongside the call that starts " +
    "the next step (it completes the current step and starts the next). If the plan changes, send items again. Skip it for a single action.",
  parameters: {
    type: "object",
    properties: {
      items: {
        type: "array",
        description: "The whole plan, in order; replaces the list.",
        items: {
          type: "object",
          properties: { content: { type: "string" }, status: { type: "string", enum: ["pending", "in_progress", "completed", "failed"] } },
          required: ["content", "status"],
        },
      },
      advance: { type: "boolean", description: "Complete the in-progress step and start the next pending one." },
    },
  },
  async execute(args: Record<string, unknown>): Promise<ToolResult> {
    const sessionId = sessionOf(args);
    if (!sessionId) return { content: "update_plan keeps a chat's step list and needs a chat session.", isError: true };
    let tasks = loadTasks();
    if (Array.isArray(args.items)) {
      const replaced = replacePlan(tasks, sessionId, args.items);
      if (typeof replaced === "string") return { content: replaced, isError: true };
      tasks = replaced;
    } else if (args.advance === true) {
      advance(tasks, sessionId);
    } else {
      return { content: "Pass items (the whole plan) or advance=true.", isError: true };
    }
    saveTasks(tasks);
    const plan = planOf(tasks, sessionId);
    return { content: planLine(plan), metadata: { plan } };
  },
};

/** wrap_up's close of the step list: the step in progress is done. A pending step stays
 *  open, so the open-steps gate still sees declared work left undone. Returns the list. */
export function finishCurrentStep(sessionId: string): PlanStep[] {
  if (!sessionId) return [];
  const tasks = loadTasks();
  const current = tasks.filter((t) => t.session_id === sessionId && t.status === "in_progress");
  if (current.length === 0) return planOf(tasks, sessionId);
  for (const t of current) { t.status = "completed"; t.updated_at = now(); }
  saveTasks(tasks);
  return planOf(tasks, sessionId);
}

export const taskTools: ToolDefinition[] = [taskCreate, taskUpdate, taskList, taskGet, updatePlan];

/** Open (pending / in_progress) tasks a given session created — the signal the
 *  open-steps completion gate reads to decide whether a turn that's about to end
 *  has left declared work unfinished. Scoped to sessionId so a task from another
 *  conversation or synced device never counts against this one. Returns id +
 *  description so the gate can name the remaining steps in its nudge. */
export function getOpenTasksForSession(sessionId: string): { id: string; description: string }[] {
  if (!sessionId) return [];
  return loadTasks()
    .filter((t) => t.session_id === sessionId && (t.status === "pending" || t.status === "in_progress"))
    .map((t) => ({ id: t.id, description: t.description }));
}
