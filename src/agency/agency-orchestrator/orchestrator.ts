import type {
  AgencyAgent,
  AgencyTask,
  AgencyPlan,
  AgencyConfig,
  AgencyStatus,
  AgencyResult,
} from "../types.js";
import { AgencyPlanner } from "../planner.js";
import { AgencyMessageBus } from "../message-bus.js";
import { planId } from "./ids.js";
import { buildStatus } from "./status.js";
import { spawnAgent as spawnAgentImpl } from "./agent-spawn.js";
import { executeOperation as executeOperationImpl, type ExecutionLoopContext } from "./execution-loop.js";

type ProgressCallback = (status: AgencyStatus) => void;

export class AgencyOrchestrator {
  private config: AgencyConfig;
  private planner: AgencyPlanner;
  private messageBus: AgencyMessageBus;
  private activePlan: AgencyPlan | null = null;
  private cancelled = false;
  private progressCallbacks: ProgressCallback[] = [];
  private startTime = 0;
  private tokensUsed = 0;
  private apiCalls = 0;
  private runningCount = 0;
  private abortController: AbortController | null = null;

  constructor(config: AgencyConfig) {
    this.config = config;
    this.planner = new AgencyPlanner();
    this.messageBus = new AgencyMessageBus();
  }

  planOperation(goal: string): AgencyPlan {
    const tasks = this.planner.decompose(goal);
    const roleMap = this.planner.assignRoles(tasks);

    const agents: AgencyAgent[] = [];
    for (const [taskId, role] of roleMap) {
      const agent = this.spawnAgent(role.name, role.systemPrompt, role.suggestedTools);
      const task = tasks.find((t) => t.id === taskId);
      if (task) {
        task.assignedTo = agent.id;
      }
      agents.push(agent);
    }

    let plan: AgencyPlan = {
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

  async executeOperation(plan: AgencyPlan): Promise<AgencyResult> {
    this.activePlan = plan;
    this.cancelled = false;
    this.startTime = Date.now();
    this.tokensUsed = 0;
    this.apiCalls = 0;
    this.runningCount = 0;
    this.abortController = new AbortController();

    return executeOperationImpl(this.buildExecutionContext(), plan);
  }

  spawnAgent(role: string, systemPrompt: string, tools: string[]): AgencyAgent {
    return spawnAgentImpl(
      this.activePlan,
      this.config,
      this.messageBus,
      role,
      systemPrompt,
      tools
    );
  }

  assignTask(agentId: string, task: AgencyTask): void {
    if (!this.activePlan) return;
    const agent = this.activePlan.agents.find((a) => a.id === agentId);
    if (!agent) throw new Error(`Agent ${agentId} not found`);

    task.assignedTo = agentId;
    agent.currentTask = task.id;
    agent.status = "idle";
  }

  getStatus(): AgencyStatus {
    return buildStatus({
      activePlan: this.activePlan,
      tokensUsed: this.tokensUsed,
      apiCalls: this.apiCalls,
      startTime: this.startTime,
    });
  }

  cancelOperation(): void {
    this.cancelled = true;
    if (this.abortController) {
      this.abortController.abort();
    }
    if (this.activePlan) {
      this.activePlan.status = "failed";
      for (const agent of this.activePlan.agents) {
        if (agent.status === "working" || agent.status === "waiting") {
          agent.status = "failed";
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

  getMessageBus(): AgencyMessageBus {
    return this.messageBus;
  }

  private emitProgress(): void {
    const status = this.getStatus();
    for (const cb of this.progressCallbacks) {
      cb(status);
    }
  }

  private buildExecutionContext(): ExecutionLoopContext {
    return {
      config: this.config,
      messageBus: this.messageBus,
      isCancelled: () => this.cancelled,
      incrementRunning: () => {
        this.runningCount++;
      },
      decrementRunning: () => {
        this.runningCount--;
      },
      incrementApiCalls: () => {
        this.apiCalls++;
      },
      addTokens: (n: number) => {
        this.tokensUsed += n;
      },
      emitProgress: () => this.emitProgress(),
      getRunningCount: () => this.runningCount,
      getTokensUsed: () => this.tokensUsed,
      getApiCalls: () => this.apiCalls,
      getStartTime: () => this.startTime,
    };
  }
}
