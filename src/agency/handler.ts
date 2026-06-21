// Agent Handler -- Master agent that stays responsive and delegates all field work
//
// Layout:
//   - handler.ts          — Handler singleton class + lifecycle
//   - handler-types.ts    — FieldAgent / FieldAgentStatus / SpawnConfig
//   - handler-tools.ts    — createHandlerTools() — public ToolDefinition factory

import { EventBus } from "../event-bus.js";
import { AgencyMessageBus } from "./message-bus.js";
import { appendTraceEvent } from "../agents/run-trace.js";
import { pushCompletionToParent } from "./handler-completion.js";
import { pushInject } from "../agent-loop/inject-queue.js";
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
      runSessionId: config.runSessionId,
      toolCalls: 0,
      abortController: ac,
    };
    this.agents.set(agentId, agent);
    // Bridge the agency message bus into the canonical loop's inject queue.
    // The bus delivers inter-agent messages (request-info / share-context),
    // but a canonically-driven run never reads agent.messageQueue — that field
    // was dead. The run's continue-gate DOES drain the inject queue keyed on
    // its session id (agent.runSessionId ?? agent-<id>, the same formula the
    // driver uses), so push there to actually reach the running agent. We keep
    // messageQueue updated too for any status reader that inspects it.
    this.messageBus.subscribe(agentId, (msg) => {
      if (msg.type === "request-info" || msg.type === "share-context") {
        const payload = String(msg.payload);
        agent.messageQueue.push(payload);
        try {
          const sessionId = agent.runSessionId ?? `agent-${agent.id}`;
          void import("../agent-loop/inject-queue.js").then(({ pushInject }) => {
            pushInject(sessionId, payload);
          });
        } catch (e) {
          logger.warn(`[handler] inject bridge failed for ${agentId}: ${(e as Error).message}`);
        }
      }
    });
    appendTraceEvent(agentId, {
      type: "run_start",
      runId: agentId,
      ts: agent.startedAt,
      role: agent.role,
      task: agent.currentTask || "",
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
      pushCompletionToParent(agent, "succeeded", outcome.result);
    } else {
      agent.status = "failed";
      agent.output.push(`[error] ${outcome.result}`);
      this.notifyUpdate(agentId, { type: "error", data: outcome.result });
      pushCompletionToParent(agent, "failed", outcome.result);
    }
    appendTraceEvent(agentId, {
      type: "run_end",
      runId: agentId,
      ts: Date.now(),
      status: agent.status,
      tokensUsed: agent.tokensUsed || undefined,
    });
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

    // Deliver the redirect to the RUNNING canonical worker via the inject
    // queue — the same primitive main-chat uses for mid-turn user messages,
    // and the same bucket the message-bus bridge (attachExternalRun) and the
    // worker's drain (drainInjectsIntoTurn, gated on opConsumesInjects →
    // true for agent_spawn) both key on: runSessionId when borrowed, else
    // agent-<id>. The old agent.messageQueue.push reached nothing — a
    // canonically-driven run never reads that field, so redirects were silently
    // dropped and the sub-agent kept running its original task.
    const sessionId = agent.runSessionId ?? `agent-${agent.id}`;
    pushInject(sessionId, newInstruction);

    // currentTask + output still feed the AGENTS sidebar / agent_status /
    // history readers, so keep them in sync with the new instruction.
    agent.currentTask = newInstruction;
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
    const done = agent.status === "succeeded" || agent.status === "failed";
    // Real progress: count tool calls the run has started. The old heuristic
    // (output.length * 5) stayed pinned at 0 for canonical-loop runs because
    // their text streams elsewhere and output[] only fills at finalize. Each
    // tool_start bumps toolCalls via noteAgentActivity; cap at 90 so an
    // in-flight run never reads as complete, and a no-tool run that's still
    // working shows a small floor instead of a dead 0.
    const calls = agent.toolCalls ?? 0;
    const working = Math.min(90, calls > 0 ? calls * 8 : 5);
    return {
      id: agent.id,
      name: agent.name,
      role: agent.role,
      status: agent.status,
      currentTask: agent.currentTask,
      progress: done ? 100 : working,
      outputLines: agent.output.length,
      startedAt: agent.startedAt,
      elapsed: Date.now() - agent.startedAt,
      tokensUsed: agent.tokensUsed,
      templateId: agent.templateId,
    };
  }

  /** Bump the real-progress counter for an externally-driven run. Called by
   *  the canonical-loop driver on each tool_start (server/handler-events.ts).
   *  buildStatus derives the live progress percentage from this — the only
   *  signal that actually moves during an external run, since output[] only
   *  fills at finalize. No-op if the run was already GC'd. */
  noteAgentActivity(agentId: string): void {
    const agent = this.agents.get(agentId);
    if (!agent) return;
    agent.toolCalls = (agent.toolCalls ?? 0) + 1;
  }


  private notifyUpdate(
    agentId: string,
    update: { type: "output" | "status" | "complete" | "error"; data: string }
  ): void {
    for (const cb of this.updateCallbacks) {
      cb(agentId, update);
    }
  }

}
