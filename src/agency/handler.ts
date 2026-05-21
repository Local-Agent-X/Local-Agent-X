// Agent Handler -- Master agent that stays responsive and delegates all field work
//
// Layout:
//   - handler.ts          — Handler singleton class + lifecycle
//   - handler-types.ts    — FieldAgent / FieldAgentStatus / SpawnConfig
//   - handler-tools.ts    — createHandlerTools() — public ToolDefinition factory

import { EventBus } from "../event-bus.js";
import { AgencyMessageBus } from "./message-bus.js";
import { createLogger } from "../logger.js";

const logger = createLogger("agency.handler");
import type {
  AgentUpdateCallback,
  FieldAgent,
  FieldAgentStatus,
  SpawnConfig,
} from "./handler-types.js";

export type {
  AgentUpdateCallback,
  FieldAgent,
  FieldAgentStatus,
} from "./handler-types.js";
export { createHandlerTools } from "./handler-tools.js";

// -- Helpers ----------------------------------------------------------------

let idCounter = 0;
function uid(prefix: string): string {
  return `${prefix}-${++idCounter}-${Date.now().toString(36)}`;
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

  // -- Attach externally-driven run ----------------------------------------

  /**
   * Register a FieldAgent record for a run that's executed by a driver
   * outside the Handler (today: canonical-loop via `agents/runtime.ts`).
   *
   * Mints the agent id, populates the in-memory registry, subscribes to the
   * agency message bus, and hands the caller the AbortController so the
   * legacy `cancelAgent` path keeps working. The caller owns the run
   * itself and must call `finalizeExternalRun` when terminal.
   *
   * Does NOT emit `handler:agent-spawn` — the caller emits it after
   * attaching so broadcast ordering stays predictable (spawn → run →
   * result).
   */
  attachExternalRun(config: SpawnConfig): { agentId: string; abortController: AbortController } {
    const agentId = uid("field-agent");
    const ac = new AbortController();
    const agent: FieldAgent = {
      id: agentId,
      name: config.name,
      role: config.role,
      status: "working",
      systemPrompt: config.systemPrompt ?? "",
      tools: config.tools ?? [],
      currentTask: config.task,
      output: [],
      startedAt: Date.now(),
      tokensUsed: 0,
      messageQueue: [],
      templateId: config.templateId,
      parentSessionId: config.parentSessionId || "",
      abortController: ac,
    };
    this.agents.set(agentId, agent);
    this.messageBus.subscribe(agentId, (msg) => {
      if (msg.type === "request-info" || msg.type === "share-context") {
        agent.messageQueue.push(String(msg.payload));
      }
    });
    return { agentId, abortController: ac };
  }

  /**
   * Mark an externally-driven run terminal. Caller (invokeDefinition's
   * driver callback) supplies the outcome; we update FieldAgent status,
   * append the result to output, notify subscribers, and schedule the
   * map entry for cleanup after 5 minutes.
   */
  finalizeExternalRun(
    agentId: string,
    outcome: { result: string; success: boolean; tokens?: number },
  ): void {
    const agent = this.agents.get(agentId);
    if (!agent) return;
    agent.result = outcome.result;
    agent.tokensUsed += outcome.tokens ?? 0;
    if (outcome.success) {
      agent.status = "succeeded";
      agent.output.push(outcome.result);
      this.notifyUpdate(agentId, { type: "complete", data: outcome.result });
      this.pushCompletionToParent(agent, "succeeded", outcome.result);
    } else {
      agent.status = "failed";
      agent.output.push(`[error] ${outcome.result}`);
      this.notifyUpdate(agentId, { type: "error", data: outcome.result });
      this.pushCompletionToParent(agent, "failed", outcome.result);
    }
    setTimeout(() => {
      const a = this.agents.get(agentId);
      if (a && (a.status === "succeeded" || a.status === "failed")) {
        this.messageBus.unsubscribe(agentId);
        this.agents.delete(agentId);
      }
    }, 5 * 60 * 1000);
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

    agent.status = "failed";
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
      const allDone = children.every(a => a.status === "succeeded" || a.status === "failed");
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

  // -- Private --------------------------------------------------------------

  private buildStatus(agent: FieldAgent): FieldAgentStatus {
    const total = agent.output.length;
    const done = agent.status === "succeeded" || agent.status === "failed";
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
    status: "succeeded" | "failed",
    result: string,
  ): void {
    const parent = agent.parentSessionId;
    if (!parent) return;
    // Loud-log if completion-queue plumbing fails. Previously the empty
    // catches swallowed import errors and enqueue errors — symptom was
    // the parent's session never learning the sub-agent finished, and
    // the AGENTS sidebar card stuck "running" until manual cleanup. With
    // logging the failure becomes greppable in server.log.
    try {
      import("./completion-queue.js").then(({ enqueueCompletion }) => {
        try {
          enqueueCompletion(parent, {
            agentId: agent.id,
            agentName: agent.name,
            status,
            result: typeof result === "string" ? result : String(result),
            timestamp: Date.now(),
          });
        } catch (e) {
          logger.error(`[handler] enqueueCompletion failed for sub-agent ${agent.id} → parent ${parent}: ${(e as Error).message}`);
        }
      }).catch((e: Error) => {
        logger.error(`[handler] completion-queue import failed for sub-agent ${agent.id} → parent ${parent}: ${e.message}`);
      });
    } catch (e) {
      logger.error(`[handler] pushCompletionToParent threw for sub-agent ${agent.id} → parent ${parent}: ${(e as Error).message}`);
    }
  }

}
