import type { AgencyPlan, AgencyStatus } from "../types.js";

export interface StatusContext {
  activePlan: AgencyPlan | null;
  tokensUsed: number;
  apiCalls: number;
  startTime: number;
}

export function buildStatus(ctx: StatusContext): AgencyStatus {
  const plan = ctx.activePlan;
  if (!plan) {
    return {
      planId: "",
      goal: "",
      status: "planning",
      agents: [],
      tasks: [],
      tokensUsed: 0,
      apiCalls: 0,
      elapsed: 0,
      tasksCompleted: 0,
      tasksFailed: 0,
      tasksRemaining: 0,
    };
  }

  return {
    planId: plan.id,
    goal: plan.goal,
    status: plan.status,
    agents: plan.agents,
    tasks: plan.tasks,
    tokensUsed: ctx.tokensUsed,
    apiCalls: ctx.apiCalls,
    elapsed: ctx.startTime > 0 ? Date.now() - ctx.startTime : 0,
    tasksCompleted: plan.tasks.filter((t) => t.status === "completed").length,
    tasksFailed: plan.tasks.filter((t) => t.status === "failed").length,
    tasksRemaining: plan.tasks.filter(
      (t) => t.status === "pending" || t.status === "running"
    ).length,
  };
}
