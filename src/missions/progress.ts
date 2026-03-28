/**
 * Mission Progress Tracking — step-by-step progress state machine.
 */

import type { ToolDefinition } from "../types.js";

export type StepStatus = "pending" | "running" | "completed" | "failed" | "skipped";

export interface StepProgress {
  stepId: string;
  status: StepStatus;
  startedAt?: number;
  completedAt?: number;
  output?: string;
  error?: string;
}

export interface MissionProgress {
  missionName: string;
  executionId: string;
  status: "pending" | "running" | "completed" | "failed" | "paused";
  steps: StepProgress[];
  startedAt: number;
  completedAt?: number;
  currentStepIndex: number;
  metadata: Record<string, unknown>;
}

const executions = new Map<string, MissionProgress>();

function generateExecId(): string {
  return `exec_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

export function startExecution(missionName: string, stepIds: string[]): MissionProgress {
  const id = generateExecId();
  const progress: MissionProgress = {
    missionName,
    executionId: id,
    status: "running",
    steps: stepIds.map(sid => ({ stepId: sid, status: "pending" })),
    startedAt: Date.now(),
    currentStepIndex: 0,
    metadata: {},
  };
  if (progress.steps.length > 0) {
    progress.steps[0].status = "running";
    progress.steps[0].startedAt = Date.now();
  }
  executions.set(id, progress);
  return progress;
}

export function completeStep(executionId: string, output?: string): StepProgress | null {
  const prog = executions.get(executionId);
  if (!prog || prog.status !== "running") return null;

  const current = prog.steps[prog.currentStepIndex];
  if (!current) return null;

  current.status = "completed";
  current.completedAt = Date.now();
  if (output) current.output = output;

  prog.currentStepIndex++;
  if (prog.currentStepIndex >= prog.steps.length) {
    prog.status = "completed";
    prog.completedAt = Date.now();
  } else {
    prog.steps[prog.currentStepIndex].status = "running";
    prog.steps[prog.currentStepIndex].startedAt = Date.now();
  }

  return current;
}

export function failStep(executionId: string, error: string): StepProgress | null {
  const prog = executions.get(executionId);
  if (!prog || prog.status !== "running") return null;

  const current = prog.steps[prog.currentStepIndex];
  if (!current) return null;

  current.status = "failed";
  current.completedAt = Date.now();
  current.error = error;
  prog.status = "failed";
  prog.completedAt = Date.now();

  return current;
}

export function skipStep(executionId: string): StepProgress | null {
  const prog = executions.get(executionId);
  if (!prog || prog.status !== "running") return null;

  const current = prog.steps[prog.currentStepIndex];
  if (!current) return null;

  current.status = "skipped";
  current.completedAt = Date.now();

  prog.currentStepIndex++;
  if (prog.currentStepIndex >= prog.steps.length) {
    prog.status = "completed";
    prog.completedAt = Date.now();
  } else {
    prog.steps[prog.currentStepIndex].status = "running";
    prog.steps[prog.currentStepIndex].startedAt = Date.now();
  }

  return current;
}

export function pauseExecution(executionId: string): boolean {
  const prog = executions.get(executionId);
  if (!prog || prog.status !== "running") return false;
  prog.status = "paused";
  return true;
}

export function resumeExecution(executionId: string): boolean {
  const prog = executions.get(executionId);
  if (!prog || prog.status !== "paused") return false;
  prog.status = "running";
  return true;
}

export function getProgress(executionId: string): MissionProgress | undefined {
  return executions.get(executionId);
}

export function getAllExecutions(): MissionProgress[] {
  return Array.from(executions.values());
}

function formatProgress(prog: MissionProgress): string {
  const completed = prog.steps.filter(s => s.status === "completed").length;
  const total = prog.steps.length;
  const pct = total > 0 ? Math.round((completed / total) * 100) : 0;
  const bar = "█".repeat(Math.floor(pct / 5)) + "░".repeat(20 - Math.floor(pct / 5));

  const stepLines = prog.steps.map((s, i) => {
    const icon = { pending: "⬜", running: "🔄", completed: "✅", failed: "❌", skipped: "⏭️" }[s.status];
    const duration = s.startedAt && s.completedAt ? ` (${((s.completedAt - s.startedAt) / 1000).toFixed(1)}s)` : "";
    return `  ${icon} ${s.stepId}${duration}${s.error ? ` — ${s.error}` : ""}`;
  }).join("\n");

  return `**${prog.missionName}** [${prog.executionId}]\nStatus: ${prog.status} | ${bar} ${pct}% (${completed}/${total})\n${stepLines}`;
}

export function createProgressTools(): ToolDefinition[] {
  return [
    {
      name: "mission_progress_start",
      description: "Start tracking progress for a mission execution.",
      parameters: {
        type: "object",
        properties: {
          missionName: { type: "string" },
          stepIds: { type: "array", items: { type: "string" }, description: "Ordered step IDs" },
        },
        required: ["missionName", "stepIds"],
      },
      async execute(args) {
        const prog = startExecution(String(args.missionName), args.stepIds as string[]);
        return { content: `Tracking started.\n\n${formatProgress(prog)}` };
      },
    },
    {
      name: "mission_progress_update",
      description: "Update the current step: complete, fail, or skip it.",
      parameters: {
        type: "object",
        properties: {
          executionId: { type: "string" },
          action: { type: "string", enum: ["complete", "fail", "skip"], description: "Action for current step" },
          output: { type: "string", description: "Step output or error message" },
        },
        required: ["executionId", "action"],
      },
      async execute(args) {
        const id = String(args.executionId);
        const action = String(args.action);
        const output = args.output ? String(args.output) : undefined;

        let step: StepProgress | null = null;
        if (action === "complete") step = completeStep(id, output);
        else if (action === "fail") step = failStep(id, output ?? "Unknown error");
        else if (action === "skip") step = skipStep(id);

        if (!step) return { content: "Execution not found or not running." };

        const prog = getProgress(id)!;
        return { content: formatProgress(prog) };
      },
    },
    {
      name: "mission_progress_get",
      description: "Get current progress of a mission execution.",
      parameters: {
        type: "object",
        properties: { executionId: { type: "string" } },
        required: ["executionId"],
      },
      async execute(args) {
        const prog = getProgress(String(args.executionId));
        if (!prog) return { content: "Execution not found." };
        return { content: formatProgress(prog) };
      },
    },
  ];
}
