// Agent Handler -- Master agent that stays responsive and delegates all field work
//
// Layout:
//   - handler.ts          — Handler singleton class + lifecycle
//   - handler-types.ts    — FieldAgent / FieldAgentStatus / DelegationResult / SpawnConfig
//   - handler-tools.ts    — createHandlerTools() — public ToolDefinition factory

import { EventBus } from "../event-bus.js";
import type { ToolResult } from "../types.js";
import { AgencyMessageBus } from "./message-bus.js";
import type {
  AgentUpdateCallback,
  DelegationResult,
  FieldAgent,
  FieldAgentStatus,
  SpawnConfig,
} from "./handler-types.js";

export type {
  AgentUpdateCallback,
  DelegationResult,
  FieldAgent,
  FieldAgentStatus,
} from "./handler-types.js";
export { createHandlerTools } from "./handler-tools.js";

// -- Helpers ----------------------------------------------------------------

let idCounter = 0;
function uid(prefix: string): string {
  return `${prefix}-${++idCounter}-${Date.now().toString(36)}`;
}

function ok(content: string): ToolResult {
  return { content };
}

function err(content: string): ToolResult {
  return { content, isError: true };
}

// -- Handler (singleton) --------------------------------------------------

let singleton: Handler | null = null;

export class Handler {
  private agents = new Map<string, FieldAgent>();
  private messageBus: AgencyMessageBus;
  private updateCallbacks: AgentUpdateCallback[] = [];
  /** Current parent session ID — set by the server before each chat turn */
  public currentSessionId: string = "";

  constructor() {
    this.messageBus = new AgencyMessageBus();
  }

  static getInstance(): Handler {
    if (!singleton) {
      singleton = new Handler();
    }
    return singleton;
  }

  static resetInstance(): void {
    if (singleton) {
      for (const [id] of singleton.agents) {
        singleton.cancelAgent(id);
      }
    }
    singleton = null;
  }

  // -- Spawn ----------------------------------------------------------------

  spawnAgent(config: SpawnConfig): string {
    const agentId = uid("field-agent");
    // parentSessionId is plumbed via SpawnConfig.parentSessionId by callers
    // (agent_spawn execute now reads args._sessionId). The previous singleton
    // fallback caused concurrent chats to inherit each other's session id.
    const parentSessionId = config.parentSessionId || "";

    const agent: FieldAgent = {
      id: agentId,
      name: config.name,
      role: config.role,
      status: "idle",
      systemPrompt: config.systemPrompt ?? "",
      tools: config.tools ?? [],
      currentTask: config.task,
      output: [],
      startedAt: Date.now(),
      tokensUsed: 0,
      messageQueue: [],
      templateId: config.templateId,
      parentSessionId,
    };

    this.agents.set(agentId, agent);

    this.messageBus.subscribe(agentId, (msg) => {
      if (msg.type === "request-info" || msg.type === "share-context") {
        agent.messageQueue.push(String(msg.payload));
      }
    });

    EventBus.emit("handler:agent-spawn", {
      agentId,
      name: config.name,
      role: config.role,
      task: config.task,
      systemPrompt: config.systemPrompt || "",
      parentSessionId,
      parentAgentId: config.parentAgentId || null,
      templateId: config.templateId || null,
    });

    this.runAgentAsync(agentId);

    return agentId;
  }

  // -- Redirect -------------------------------------------------------------

  redirectAgent(agentId: string, newInstruction: string): void {
    const agent = this.agents.get(agentId);
    if (!agent) throw new Error(`Agent ${agentId} not found`);

    agent.currentTask = newInstruction;
    agent.messageQueue.push(newInstruction);
    agent.output.push(`[redirect] ${newInstruction}`);

    this.notifyUpdate(agentId, { type: "status", data: `Redirected: ${newInstruction}` });

    EventBus.emit("handler:agent-redirect", {
      agentId,
      newInstruction,
    });
  }

  // -- Pause / Resume -------------------------------------------------------

  pauseAgent(agentId: string): void {
    const agent = this.agents.get(agentId);
    if (!agent) throw new Error(`Agent ${agentId} not found`);

    if (agent.pauseSignal) {
      agent.pauseSignal.paused = true;
    } else {
      agent.pauseSignal = { paused: true };
    }
    agent.status = "waiting";
    agent.output.push("[paused]");

    this.notifyUpdate(agentId, { type: "status", data: "paused" });

    EventBus.emit("handler:agent-pause", { agentId });
  }

  resumeAgent(agentId: string): void {
    const agent = this.agents.get(agentId);
    if (!agent) throw new Error(`Agent ${agentId} not found`);

    if (agent.pauseSignal) {
      agent.pauseSignal.paused = false;
      if (agent.pauseSignal.resume) {
        agent.pauseSignal.resume();
      }
    }
    agent.status = "working";
    agent.output.push("[resumed]");

    this.notifyUpdate(agentId, { type: "status", data: "resumed" });

    EventBus.emit("handler:agent-resume", { agentId });
  }

  // -- Cancel ---------------------------------------------------------------

  cancelAgent(agentId: string): void {
    const agent = this.agents.get(agentId);
    if (!agent) return;

    if (agent.abortController) {
      agent.abortController.abort();
    }
    if (agent.pauseSignal) {
      agent.pauseSignal.paused = false;
      if (agent.pauseSignal.resume) agent.pauseSignal.resume();
    }

    agent.status = "error";
    agent.output.push("[cancelled]");
    this.messageBus.unsubscribe(agentId);

    this.notifyUpdate(agentId, { type: "status", data: "cancelled" });

    EventBus.emit("handler:agent-cancel", { agentId });
  }

  // -- Status / Output ------------------------------------------------------

  getAgentStatus(agentId?: string): FieldAgentStatus | FieldAgentStatus[] {
    if (agentId) {
      const agent = this.agents.get(agentId);
      if (!agent) throw new Error(`Agent ${agentId} not found`);
      return this.buildStatus(agent);
    }
    return [...this.agents.values()].map((a) => this.buildStatus(a));
  }

  getAgentOutput(agentId: string): string[] {
    const agent = this.agents.get(agentId);
    if (!agent) throw new Error(`Agent ${agentId} not found`);
    return [...agent.output];
  }

  /** Wait for all agents spawned by a parent session to finish, return their results */
  async waitForSessionAgents(parentSessionId: string, timeoutMs = 300_000): Promise<string[]> {
    const deadline = Date.now() + timeoutMs;
    const results: string[] = [];
    let sawChildren = false;
    while (Date.now() < deadline) {
      const children = [...this.agents.values()].filter(a => a.parentSessionId === parentSessionId);
      if (children.length > 0) sawChildren = true;
      // Only exit-on-zero if we already saw children (they all finished and were cleaned up)
      // or we've been waiting 30s with nothing spawning (no delegation happened)
      if (children.length === 0) {
        if (sawChildren) break;
        if (Date.now() - (deadline - timeoutMs) > 30_000) break;
        await new Promise(r => setTimeout(r, 2000));
        continue;
      }
      const allDone = children.every(a => a.status === "done" || a.status === "error");
      if (allDone) {
        for (const child of children) {
          if (child.result) results.push(child.result);
        }
        break;
      }
      await new Promise(r => setTimeout(r, 3000)); // Poll every 3s
    }
    return results;
  }

  // -- Subscriptions --------------------------------------------------------

  onAgentUpdate(callback: AgentUpdateCallback): void {
    this.updateCallbacks.push(callback);
  }

  // -- Message --------------------------------------------------------------

  messageAgent(agentId: string, message: string): void {
    const agent = this.agents.get(agentId);
    if (!agent) throw new Error(`Agent ${agentId} not found`);

    agent.messageQueue.push(message);
    agent.output.push(`[message-in] ${message}`);

    this.messageBus.send("handler", agentId, "share-context", message);

    this.notifyUpdate(agentId, { type: "output", data: message });
  }

  // -- Delegation -----------------------------------------------------------

  delegateTask(goal: string): DelegationResult {
    const planId = uid("plan");
    const segments = this.decompose(goal);
    const spawned: FieldAgentStatus[] = [];
    const taskList: string[] = [];

    for (const seg of segments) {
      const agentId = this.spawnAgent({
        name: seg.name,
        role: seg.role,
        task: seg.task,
      });
      const agent = this.agents.get(agentId)!;
      spawned.push(this.buildStatus(agent));
      taskList.push(seg.task);
    }

    EventBus.emit("handler:delegation", { planId, goal, agentCount: spawned.length });

    return { planId, agents: spawned, tasks: taskList };
  }

  // -- Private --------------------------------------------------------------

  private buildStatus(agent: FieldAgent): FieldAgentStatus {
    const total = agent.output.length;
    const done = agent.status === "done" || agent.status === "error";
    return {
      id: agent.id,
      name: agent.name,
      role: agent.role,
      status: agent.status,
      currentTask: agent.currentTask,
      progress: done ? 100 : Math.min(95, total * 5),
      outputLines: total,
      startedAt: agent.startedAt,
      elapsed: Date.now() - agent.startedAt,
      tokensUsed: agent.tokensUsed,
    };
  }

  private notifyUpdate(
    agentId: string,
    update: { type: "output" | "status" | "complete" | "error"; data: string }
  ): void {
    for (const cb of this.updateCallbacks) {
      cb(agentId, update);
    }
  }

  /** Push a completion notice onto the parent session's queue so the parent's
   * agent loop sees it on the next iteration without needing to poll. */
  private pushCompletionToParent(
    agent: FieldAgent,
    status: "done" | "error",
    result: string,
  ): void {
    const parent = agent.parentSessionId;
    if (!parent) return;
    try {
      import("./completion-queue.js").then(({ enqueueCompletion }) => {
        enqueueCompletion(parent, {
          agentId: agent.id,
          agentName: agent.name,
          status,
          result: typeof result === "string" ? result : String(result),
          timestamp: Date.now(),
        });
      }).catch(() => {});
    } catch {}
  }

  private runAgentAsync(agentId: string): void {
    const agent = this.agents.get(agentId);
    if (!agent) return;

    agent.status = "working";
    agent.abortController = new AbortController();

    const run = async () => {
      try {
        // Wait for pause if needed
        const checkPause = (): Promise<void> => {
          if (!agent.pauseSignal || !agent.pauseSignal.paused) {
            return Promise.resolve();
          }
          return new Promise<void>((resolve) => {
            agent.pauseSignal!.resume = resolve;
          });
        };

        await checkPause();

        if (agent.abortController?.signal.aborted) return;

        // Subscribe to tool activity for live monitoring
        const outputHandler = (data: unknown) => {
          const d = data as { agentId: string; output?: string };
          if (d.agentId !== agentId || typeof d.output !== "string") return;
          // Keep last 50 activity entries per agent (tool calls, progress, errors)
          if (d.output.startsWith("[tool]") || d.output.startsWith("[progress]") || d.output.startsWith("[error]") || d.output.startsWith("[BLOCKER]")) {
            agent.output.push(d.output);
            if (agent.output.length > 50) agent.output.shift();
          }
        };
        EventBus.on("handler:agent-output", outputHandler);

        // Emit the run request for the external LLM layer to pick up
        const resultPromise = new Promise<string>((resolve, reject) => {
          let resultHandler: ((data: unknown) => void) | null = null;
          const timeout = setTimeout(() => {
            EventBus.off("handler:agent-output", outputHandler);
            if (resultHandler) EventBus.off("handler:agent-result", resultHandler);
            reject(new Error("Agent execution timed out"));
          }, 600_000); // 10 min — agents need time for multi-step tasks

          const handler = (data: unknown) => {
            const d = data as {
              agentId: string;
              result?: string;
              error?: string;
              tokens?: number;
              chunk?: string;
            };
            if (d.agentId !== agentId) return;

            if (d.chunk) {
              agent.output.push(d.chunk);
              if (agent.streamCallback) {
                agent.streamCallback(agentId, d.chunk);
              }
              this.notifyUpdate(agentId, { type: "output", data: d.chunk });
              return;
            }

            clearTimeout(timeout);
            EventBus.off("handler:agent-result", handler);
            EventBus.off("handler:agent-output", outputHandler);

            if (d.tokens) agent.tokensUsed += d.tokens;

            if (d.error) {
              reject(new Error(d.error));
            } else {
              resolve(d.result ?? "");
            }
          };

          resultHandler = handler;
          EventBus.on("handler:agent-result", handler);

          if (agent.abortController?.signal.aborted) {
            clearTimeout(timeout);
            EventBus.off("handler:agent-result", handler);
            EventBus.off("handler:agent-output", outputHandler);
            reject(new Error("Aborted"));
          }
        });

        await EventBus.emit("handler:agent-run", {
          agentId,
          name: agent.name,
          role: agent.role,
          systemPrompt: agent.systemPrompt,
          tools: agent.tools,
          task: agent.currentTask,
          parentSessionId: agent.parentSessionId || undefined,
          templateId: agent.templateId,
        });

        const result = await resultPromise;

        // Detect content-moderation / empty-response sentinel from Codex path.
        // Sub-agents that return only the placeholder are NOT done — they
        // were blocked. Mark as error so the parent can react and the UI
        // doesn't silently swallow the failure.
        const isEmptyResponseSentinel =
          typeof result === "string" &&
          (result.includes("model returned an empty response") ||
            result.includes("content moderation blocked"));

        agent.result = result;
        if (isEmptyResponseSentinel) {
          agent.status = "error";
          agent.output.push(`[blocked] ${result}`);
          this.notifyUpdate(agentId, { type: "error", data: result });
          EventBus.emit("handler:agent-error", { agentId, error: result });
          this.pushCompletionToParent(agent, "error", result);
        } else {
          agent.status = "done";
          agent.output.push(result);
          this.notifyUpdate(agentId, { type: "complete", data: result });
          EventBus.emit("handler:agent-done", { agentId, result });
          this.pushCompletionToParent(agent, "done", result);
        }
      } catch (e) {
        const msg = String(e);
        if (!agent.abortController?.signal.aborted) {
          agent.status = "error";
          agent.result = msg;
          agent.output.push(`[error] ${msg}`);
          this.notifyUpdate(agentId, { type: "error", data: msg });
          EventBus.emit("handler:agent-error", { agentId, error: msg });
          this.pushCompletionToParent(agent, "error", msg);
        }
      }
      // Clean up completed/errored agents after 5 minutes to prevent unbounded growth
      setTimeout(() => {
        const a = this.agents.get(agentId);
        if (a && (a.status === "done" || a.status === "error")) {
          this.messageBus.unsubscribe(agentId);
          this.agents.delete(agentId);
        }
      }, 5 * 60 * 1000);
    };

    run();
  }

  private decompose(goal: string): { name: string; role: string; task: string }[] {
    const lower = goal.toLowerCase();
    const segments: { name: string; role: string; task: string }[] = [];

    // Keyword-based heuristic decomposition
    const hasResearch = /research|find|look up|search|investigate|analyze/.test(lower);
    const hasBuild = /build|create|write|code|implement|develop|generate/.test(lower);
    const hasReview = /review|check|test|verify|validate|audit/.test(lower);
    const hasPlan = /plan|design|architect|outline|strategy/.test(lower);

    if (hasPlan) {
      segments.push({ name: "planner", role: "planner", task: `Plan the approach: ${goal}` });
    }

    if (hasResearch) {
      segments.push({ name: "researcher", role: "researcher", task: `Research: ${goal}` });
    }

    if (hasBuild) {
      segments.push({ name: "builder", role: "coder", task: `Build: ${goal}` });
    }

    if (hasReview) {
      segments.push({ name: "reviewer", role: "reviewer", task: `Review: ${goal}` });
    }

    // Fallback: single general agent
    if (segments.length === 0) {
      segments.push({ name: "worker", role: "generalist", task: goal });
    }

    return segments;
  }
}
