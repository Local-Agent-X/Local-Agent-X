import type { AgencyConfig, AgencyPlan, AgencyResult } from "../types.js";
import { AgencyMessageBus } from "../message-bus.js";
import { EventBus } from "../../event-bus.js";
import { executeTask, type TaskExecutionContext } from "./task-executor.js";
import { sleep } from "./ids.js";

export interface ExecutionLoopContext extends TaskExecutionContext {
  config: AgencyConfig;
  messageBus: AgencyMessageBus;
  getRunningCount: () => number;
  getTokensUsed: () => number;
  getApiCalls: () => number;
  getStartTime: () => number;
}

export async function executeOperation(
  ctx: ExecutionLoopContext,
  plan: AgencyPlan
): Promise<AgencyResult> {
  plan.status = "running";
  await EventBus.emit("agency:start", { planId: plan.id, goal: plan.goal });
  ctx.emitProgress();

  const results = new Map<string, string>();
  const completed = new Set<string>();

  try {
    while (completed.size < plan.tasks.length) {
      if (ctx.isCancelled()) {
        plan.status = "failed";
        await EventBus.emit("agency:error", {
          planId: plan.id,
          error: "Cancelled",
        });
        break;
      }

      const ready = plan.tasks.filter(
        (t) =>
          t.status === "pending" &&
          t.dependsOn.every((dep) => completed.has(dep))
      );

      if (ready.length === 0 && ctx.getRunningCount() === 0) {
        break;
      }

      const toRun = ready.slice(
        0,
        ctx.config.maxConcurrent - ctx.getRunningCount()
      );
      const promises = toRun.map((task) =>
        executeTask(ctx, plan, task, results)
      );

      if (promises.length > 0) {
        const settled = await Promise.allSettled(promises);
        for (let i = 0; i < settled.length; i++) {
          const task = toRun[i];
          const outcome = settled[i];

          if (outcome.status === "fulfilled" && outcome.value) {
            results.set(task.id, outcome.value);
            task.result = outcome.value;
            task.status = "completed";
            task.completedAt = Date.now();
            completed.add(task.id);

            ctx.messageBus.publishContext(task.id, outcome.value);
            await EventBus.emit("agency:task-complete", {
              planId: plan.id,
              taskId: task.id,
            });
          } else {
            task.status = "failed";
            task.completedAt = Date.now();
            completed.add(task.id);
            const reason =
              outcome.status === "rejected"
                ? String(outcome.reason)
                : "No result";
            task.result = `FAILED: ${reason}`;
            results.set(task.id, task.result);
            await EventBus.emit("agency:error", {
              planId: plan.id,
              taskId: task.id,
              error: reason,
            });
          }

          ctx.emitProgress();
        }
      } else {
        await sleep(100);
      }
    }

    for (const task of plan.tasks) {
      if (task.status === "pending") {
        task.status = "skipped";
        completed.add(task.id);
      }
    }

    const anyFailed = plan.tasks.some((t) => t.status === "failed");
    plan.status = ctx.isCancelled()
      ? "failed"
      : anyFailed
        ? "failed"
        : "completed";

    const summaryParts: string[] = [];
    for (const task of plan.tasks) {
      if (task.result && task.status === "completed") {
        summaryParts.push(
          `[${task.id}] ${task.description}: ${task.result}`
        );
      }
    }

    const result: AgencyResult = {
      planId: plan.id,
      goal: plan.goal,
      success: plan.status === "completed",
      results,
      tokensUsed: ctx.getTokensUsed(),
      apiCalls: ctx.getApiCalls(),
      elapsed: Date.now() - ctx.getStartTime(),
      summary: summaryParts.join("\n\n") || "No results produced.",
    };

    await EventBus.emit("agency:complete", {
      planId: plan.id,
      success: result.success,
      elapsed: result.elapsed,
    });

    for (const agent of plan.agents) {
      agent.status = "succeeded";
    }

    ctx.emitProgress();
    return result;
  } catch (err) {
    plan.status = "failed";
    await EventBus.emit("agency:error", {
      planId: plan.id,
      error: String(err),
    });
    return {
      planId: plan.id,
      goal: plan.goal,
      success: false,
      results,
      tokensUsed: ctx.getTokensUsed(),
      apiCalls: ctx.getApiCalls(),
      elapsed: Date.now() - ctx.getStartTime(),
      summary: `Operation failed: ${String(err)}`,
    };
  }
}
