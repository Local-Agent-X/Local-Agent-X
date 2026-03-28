// Swarm Orchestrator -- Main coordinator for multi-agent task execution

import type {
  SwarmAgent,
  SwarmTask,
  SwarmPlan,
  SwarmConfig,
  SwarmStatus,
  SwarmResult,
  AgentStatus,
  PlanStatus,
} from "./types.js";
import { SwarmPlanner } from "./planner.js";
import { SwarmMessageBus } from "./message-bus.js";
import { getRole } from "./agent-roles.js";
import { EventBus } from "../event-bus.js";

type ProgressCallback = (status: SwarmStatus) => void;

let agentCounter = 0;
function nextAgentId(): string {
  return `agent-${++agentCounter}-${Date.now().toString(36)}`;
}

function planId(): string {
  return `plan-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

export class SwarmOrchestrator {
  private config: SwarmConfig;
  private planner: SwarmPlanner;
  private messageBus: SwarmMessageBus;
  private activePlan: SwarmPlan | null = null;
  private cancelled = false;
  private progressCallbacks: ProgressCallback[] = [];
  private startTime = 0;
  private tokensUsed = 0;
  private apiCalls = 0;
  private runningCount = 0;
  private abortController: AbortController | null = null;

  constructor(config: SwarmConfig) {
    this.config = config;
    this.planner = new SwarmPlanner();
    this.messageBus = new SwarmMessageBus();
  }

  planSwarm(goal: string): SwarmPlan {
    const tasks = this.planner.decompose(goal);
    const roleMap = this.planner.assignRoles(tasks);

    const agents: SwarmAgent[] = [];
    for (const [taskId, role] of roleMap) {
      const agent = this.spawnAgent(role.name, role.systemPrompt, role.suggestedTools);
      const task = tasks.find((t) => t.id === taskId);
      if (task) {
        task.assignedTo = agent.id;
      }
      agents.push(agent);
    }

    let plan: SwarmPlan = {
      id: planId(),
      goal,
      tasks,
      agents,
      createdAt: Date.now(),
      status: "planning",
    };

    plan = this.planner.optimize(plan);
    this.activePlan = plan;
    return plan;
  }

  async executeSwarm(plan: SwarmPlan): Promise<SwarmResult> {
    this.activePlan = plan;
    this.cancelled = false;
    this.startTime = Date.now();
    this.tokensUsed = 0;
    this.apiCalls = 0;
    this.runningCount = 0;
    this.abortController = new AbortController();

    plan.status = "running";
    await EventBus.emit("swarm:start", { planId: plan.id, goal: plan.goal });
    this.emitProgress();

    const graph = this.planner.buildDependencyGraph(plan.tasks);
    const results = new Map<string, string>();
    const completed = new Set<string>();

    try {
      // Process tasks in topological order, running independent tasks in parallel
      while (completed.size < plan.tasks.length) {
        if (this.cancelled) {
          plan.status = "failed";
          await EventBus.emit("swarm:error", { planId: plan.id, error: "Cancelled" });
          break;
        }

        // Find tasks whose dependencies are all complete
        const ready = plan.tasks.filter(
          (t) =>
            t.status === "pending" &&
            t.dependsOn.every((dep) => completed.has(dep))
        );

        if (ready.length === 0 && this.runningCount === 0) {
          // No ready tasks and nothing running -- deadlock or all done
          break;
        }

        // Launch ready tasks up to concurrency limit
        const toRun = ready.slice(0, this.config.maxConcurrent - this.runningCount);
        const promises = toRun.map((task) =>
          this.executeTask(plan, task, results)
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

              // Share result via message bus
              this.messageBus.publishContext(task.id, outcome.value);
              await EventBus.emit("swarm:task-complete", {
                planId: plan.id,
                taskId: task.id,
              });
            } else {
              task.status = "failed";
              task.completedAt = Date.now();
              completed.add(task.id);
              const reason =
                outcome.status === "rejected" ? String(outcome.reason) : "No result";
              task.result = `FAILED: ${reason}`;
              results.set(task.id, task.result);
              await EventBus.emit("swarm:error", {
                planId: plan.id,
                taskId: task.id,
                error: reason,
              });
            }

            this.emitProgress();
          }
        } else {
          // Nothing to launch; wait briefly for running tasks
          await sleep(100);
        }
      }

      // Skip any tasks whose dependencies failed
      for (const task of plan.tasks) {
        if (task.status === "pending") {
          task.status = "skipped";
          completed.add(task.id);
        }
      }

      const allDone = plan.tasks.every(
        (t) => t.status === "completed" || t.status === "skipped"
      );
      const anyFailed = plan.tasks.some((t) => t.status === "failed");
      plan.status = this.cancelled
        ? "failed"
        : anyFailed
          ? "failed"
          : "completed";

      // Build summary from final results
      const summaryParts: string[] = [];
      for (const task of plan.tasks) {
        if (task.result && task.status === "completed") {
          summaryParts.push(`[${task.id}] ${task.description}: ${task.result}`);
        }
      }

      const result: SwarmResult = {
        planId: plan.id,
        goal: plan.goal,
        success: plan.status === "completed",
        results,
        tokensUsed: this.tokensUsed,
        apiCalls: this.apiCalls,
        elapsed: Date.now() - this.startTime,
        summary: summaryParts.join("\n\n") || "No results produced.",
      };

      await EventBus.emit("swarm:complete", {
        planId: plan.id,
        success: result.success,
        elapsed: result.elapsed,
      });

      // Set all agents to done
      for (const agent of plan.agents) {
        agent.status = "done";
      }

      this.emitProgress();
      return result;
    } catch (err) {
      plan.status = "failed";
      await EventBus.emit("swarm:error", {
        planId: plan.id,
        error: String(err),
      });
      return {
        planId: plan.id,
        goal: plan.goal,
        success: false,
        results,
        tokensUsed: this.tokensUsed,
        apiCalls: this.apiCalls,
        elapsed: Date.now() - this.startTime,
        summary: `Swarm failed: ${String(err)}`,
      };
    }
  }

  spawnAgent(
    role: string,
    systemPrompt: string,
    tools: string[]
  ): SwarmAgent {
    if (
      this.activePlan &&
      this.activePlan.agents.length >= this.config.maxAgents
    ) {
      throw new Error(
        `Max agents (${this.config.maxAgents}) reached. Cannot spawn more.`
      );
    }

    const roleDef = getRole(role);
    const agent: SwarmAgent = {
      id: nextAgentId(),
      name: `${role}-${Date.now().toString(36)}`,
      role,
      status: "idle",
      systemPrompt: systemPrompt || roleDef?.systemPrompt || "",
      tools: tools.length > 0 ? tools : roleDef?.suggestedTools ?? [],
    };

    // Subscribe to message bus
    this.messageBus.subscribe(agent.id, (msg) => {
      if (msg.type === "request-info") {
        // Agents can respond to info requests through the bus
        EventBus.emit("swarm:info-request", {
          from: msg.from,
          to: agent.id,
          payload: msg.payload,
        });
      }
    });

    return agent;
  }

  assignTask(agentId: string, task: SwarmTask): void {
    if (!this.activePlan) return;
    const agent = this.activePlan.agents.find((a) => a.id === agentId);
    if (!agent) throw new Error(`Agent ${agentId} not found`);

    task.assignedTo = agentId;
    agent.currentTask = task.id;
    agent.status = "idle";
  }

  getStatus(): SwarmStatus {
    const plan = this.activePlan;
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
      tokensUsed: this.tokensUsed,
      apiCalls: this.apiCalls,
      elapsed: this.startTime > 0 ? Date.now() - this.startTime : 0,
      tasksCompleted: plan.tasks.filter((t) => t.status === "completed").length,
      tasksFailed: plan.tasks.filter((t) => t.status === "failed").length,
      tasksRemaining: plan.tasks.filter(
        (t) => t.status === "pending" || t.status === "running"
      ).length,
    };
  }

  cancelSwarm(): void {
    this.cancelled = true;
    if (this.abortController) {
      this.abortController.abort();
    }
    if (this.activePlan) {
      this.activePlan.status = "failed";
      for (const agent of this.activePlan.agents) {
        if (agent.status === "working" || agent.status === "waiting") {
          agent.status = "error";
        }
      }
      for (const task of this.activePlan.tasks) {
        if (task.status === "running") {
          task.status = "failed";
          task.result = "Cancelled";
          task.completedAt = Date.now();
        }
      }
    }
    this.messageBus.clear();
  }

  onProgress(callback: ProgressCallback): void {
    this.progressCallbacks.push(callback);
  }

  getMessageBus(): SwarmMessageBus {
    return this.messageBus;
  }

  // Internal: execute a single task with its assigned agent
  private async executeTask(
    plan: SwarmPlan,
    task: SwarmTask,
    previousResults: Map<string, string>
  ): Promise<string> {
    if (this.cancelled) throw new Error("Cancelled");

    task.status = "running";
    task.startedAt = Date.now();
    this.runningCount++;

    const agent = plan.agents.find((a) => a.id === task.assignedTo);
    if (agent) {
      agent.status = "working";
      agent.currentTask = task.id;
    }

    await EventBus.emit("swarm:task-start", {
      planId: plan.id,
      taskId: task.id,
      agentId: task.assignedTo,
    });
    this.emitProgress();

    try {
      // Build context from dependency results
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

      // Construct the prompt for the headless agent
      const taskPrompt = `${task.description}${contextBlock}`;

      // Track resource usage
      this.apiCalls++;

      // Apply timeout
      const timeoutMs = this.config.timeout;
      const result = await withTimeout(
        this.runHeadlessAgent(task, taskPrompt, agent),
        timeoutMs
      );

      if (agent) {
        agent.status = "done";
        agent.currentTask = undefined;
        agent.result = result;
      }

      this.runningCount--;
      return result;
    } catch (err) {
      if (agent) {
        agent.status = "error";
      }
      this.runningCount--;
      throw err;
    }
  }

  // Headless agent execution stub -- the actual LLM call is wired in separately
  // through agent.ts. This returns a placeholder indicating the task prompt
  // that should be sent to the configured provider/model.
  private async runHeadlessAgent(
    task: SwarmTask,
    prompt: string,
    agent: SwarmAgent | undefined
  ): Promise<string> {
    // Emit the task for external execution. The server/agent layer hooks into
    // "swarm:agent-run" to actually call the LLM and return the response.
    const responsePromise = new Promise<string>((resolve, reject) => {
      const timeoutHandle = setTimeout(() => {
        reject(new Error(`Agent task timed out: ${task.id}`));
      }, this.config.timeout);

      const handler = (data: unknown) => {
        const d = data as { taskId: string; result?: string; error?: string; tokens?: number };
        if (d.taskId !== task.id) return;
        clearTimeout(timeoutHandle);
        EventBus.off("swarm:agent-result", handler);
        if (d.tokens) this.tokensUsed += d.tokens;
        if (d.error) {
          reject(new Error(d.error));
        } else {
          resolve(d.result ?? "");
        }
      };

      EventBus.on("swarm:agent-result", handler);
    });

    await EventBus.emit("swarm:agent-run", {
      taskId: task.id,
      agentId: agent?.id,
      role: agent?.role,
      systemPrompt: agent?.systemPrompt,
      tools: agent?.tools,
      prompt,
      provider: this.config.provider,
      model: this.config.model,
    });

    return responsePromise;
  }

  private emitProgress(): void {
    const status = this.getStatus();
    for (const cb of this.progressCallbacks) {
      cb(status);
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Task timed out")), ms);
    promise.then(
      (val) => {
        clearTimeout(timer);
        resolve(val);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      }
    );
  });
}
