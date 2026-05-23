import type { AgencyAgent, AgencyPlan, AgencyTask } from "../types.js";
import { EventBus } from "../../event-bus.js";
import { runHeadlessAgent, type HeadlessRunContext } from "./headless-runner.js";
import { withTimeout } from "./ids.js";

export interface TaskExecutionContext extends HeadlessRunContext {
  isCancelled: () => boolean;
  incrementRunning: () => void;
  decrementRunning: () => void;
  incrementApiCalls: () => void;
  emitProgress: () => void;
}

export async function executeTask(
  ctx: TaskExecutionContext,
  plan: AgencyPlan,
  task: AgencyTask,
  previousResults: Map<string, string>
): Promise<string> {
  if (ctx.isCancelled()) throw new Error("Cancelled");

  task.status = "running";
  task.startedAt = Date.now();
  ctx.incrementRunning();

  const agent = plan.agents.find((a) => a.id === task.assignedTo);
  if (agent) {
    agent.status = "working";
    agent.currentTask = task.id;
  }

  await EventBus.emit("agency:task-start", {
    planId: plan.id,
    taskId: task.id,
    agentId: task.assignedTo,
  });
  ctx.emitProgress();

  try {
    const taskPrompt = buildTaskPrompt(task, plan, previousResults);
    ctx.incrementApiCalls();

    const result = await withTimeout(
      runHeadlessAgent(ctx, task, taskPrompt, agent),
      ctx.config.timeout
    );

    if (agent) {
      agent.status = "succeeded";
      agent.currentTask = undefined;
      agent.result = result;
    }

    ctx.decrementRunning();
    return result;
  } catch (err) {
    if (agent) {
      agent.status = "failed";
    }
    ctx.decrementRunning();
    throw err;
  }
}

function buildTaskPrompt(
  task: AgencyTask,
  plan: AgencyPlan,
  previousResults: Map<string, string>
): string {
  const contextParts: string[] = [];
  for (const depId of task.dependsOn) {
    const depResult = previousResults.get(depId);
    if (depResult) {
      const depTask = plan.tasks.find((t) => t.id === depId);
      contextParts.push(
        `Result from "${depTask?.description ?? depId}":\n${depResult}`
      );
    }
  }

  const contextBlock =
    contextParts.length > 0
      ? `\n\nContext from previous tasks:\n${contextParts.join("\n---\n")}`
      : "";

  return `${task.description}${contextBlock}`;
}
