// Agent Handler -- Master agent that stays responsive and delegates all field work

import { EventBus } from "../event-bus.js";
import type {
  AgencyAgent,
  AgentStatus,
} from "./types.js";
import type { ToolDefinition, ToolResult } from "../types.js";
import { AgencyMessageBus } from "./message-bus.js";

// -- Types ------------------------------------------------------------------

export interface FieldAgent extends AgencyAgent {
  output: string[];
  streamCallback?: (agentId: string, chunk: string) => void;
  abortController?: AbortController;
  pauseSignal?: { paused: boolean; resume?: () => void };
  startedAt: number;
  tokensUsed: number;
  messageQueue: string[];
  templateId?: string;
  /** Captured at spawn time to avoid the singleton race on Handler.currentSessionId */
  parentSessionId?: string;
}

export interface FieldAgentStatus {
  id: string;
  name: string;
  role: string;
  status: AgentStatus;
  currentTask: string | undefined;
  progress: number;
  outputLines: number;
  startedAt: number;
  elapsed: number;
  tokensUsed: number;
}

export interface DelegationResult {
  planId: string;
  agents: FieldAgentStatus[];
  tasks: string[];
}

interface SpawnConfig {
  name: string;
  role: string;
  task: string;
  systemPrompt?: string;
  tools?: string[];
  parentSessionId?: string;
  parentAgentId?: string;
  templateId?: string;
}

type AgentUpdateCallback = (agentId: string, update: {
  type: "output" | "status" | "complete" | "error";
  data: string;
}) => void;

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
    // Capture the session ID at spawn time so concurrent chats don't cross-pollinate
    const parentSessionId = config.parentSessionId || this.currentSessionId || "";

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
        } else {
          agent.status = "done";
          agent.output.push(result);
          this.notifyUpdate(agentId, { type: "complete", data: result });
          EventBus.emit("handler:agent-done", { agentId, result });
        }
      } catch (e) {
        const msg = String(e);
        if (!agent.abortController?.signal.aborted) {
          agent.status = "error";
          agent.result = msg;
          agent.output.push(`[error] ${msg}`);
          this.notifyUpdate(agentId, { type: "error", data: msg });
          EventBus.emit("handler:agent-error", { agentId, error: msg });
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

// -- Handler Tools ---------------------------------------------------------------

export function createHandlerTools(): ToolDefinition[] {
  return [
    {
      name: "agent_spawn",
      description:
        "Spawn a new agent with a specific role and task. " +
        "The agent runs asynchronously and reports back when done.",
      parameters: {
        type: "object",
        properties: {
          name: { type: "string", description: "Name for the agent" },
          role: { type: "string", description: "Agent role (researcher, coder, reviewer, planner, etc.)" },
          task: { type: "string", description: "The task for the agent to perform" },
          system_prompt: { type: "string", description: "Optional system prompt override" },
          tools: {
            type: "array",
            items: { type: "string" },
            description: "Optional list of tool names the agent can use",
          },
        },
        required: ["name", "role", "task"],
      },
      async execute(args) {
        try {
          const handler = Handler.getInstance();
          const agentId = handler.spawnAgent({
            name: String(args.name),
            role: String(args.role),
            task: String(args.task),
            systemPrompt: args.system_prompt ? String(args.system_prompt) : undefined,
            tools: Array.isArray(args.tools) ? args.tools.map(String) : undefined,
            parentSessionId: handler.currentSessionId || undefined,
          });
          const status = handler.getAgentStatus(agentId) as FieldAgentStatus;
          return ok(
            `Agent spawned: ${agentId}\n` +
            `Name: ${status.name}\n` +
            `Role: ${status.role}\n` +
            `Task: ${status.currentTask}\n` +
            `Status: ${status.status}`
          );
        } catch (e) {
          return err(`Failed to spawn agent: ${String(e)}`);
        }
      },
    },
    {
      name: "agent_redirect",
      description: "Change a running agent's task or focus to a new instruction.",
      parameters: {
        type: "object",
        properties: {
          agent_id: { type: "string", description: "ID of the agent to redirect" },
          instruction: { type: "string", description: "New instruction for the agent" },
        },
        required: ["agent_id", "instruction"],
      },
      async execute(args) {
        try {
          const handler = Handler.getInstance();
          handler.redirectAgent(String(args.agent_id), String(args.instruction));
          return ok(`Agent ${args.agent_id} redirected to: ${args.instruction}`);
        } catch (e) {
          return err(`Failed to redirect agent: ${String(e)}`);
        }
      },
    },
    {
      name: "agent_pause",
      description: "Pause a running agent's execution.",
      parameters: {
        type: "object",
        properties: {
          agent_id: { type: "string", description: "ID of the agent to pause" },
        },
        required: ["agent_id"],
      },
      async execute(args) {
        try {
          const handler = Handler.getInstance();
          handler.pauseAgent(String(args.agent_id));
          return ok(`Agent ${args.agent_id} paused.`);
        } catch (e) {
          return err(`Failed to pause agent: ${String(e)}`);
        }
      },
    },
    {
      name: "agent_resume",
      description: "Resume a paused agent's execution.",
      parameters: {
        type: "object",
        properties: {
          agent_id: { type: "string", description: "ID of the agent to resume" },
        },
        required: ["agent_id"],
      },
      async execute(args) {
        try {
          const handler = Handler.getInstance();
          handler.resumeAgent(String(args.agent_id));
          return ok(`Agent ${args.agent_id} resumed.`);
        } catch (e) {
          return err(`Failed to resume agent: ${String(e)}`);
        }
      },
    },
    {
      name: "agent_cancel",
      description: "Cancel a running agent and clean up its resources.",
      parameters: {
        type: "object",
        properties: {
          agent_id: { type: "string", description: "ID of the agent to cancel" },
        },
        required: ["agent_id"],
      },
      async execute(args) {
        try {
          const handler = Handler.getInstance();
          handler.cancelAgent(String(args.agent_id));
          return ok(`Agent ${args.agent_id} cancelled.`);
        } catch (e) {
          return err(`Failed to cancel agent: ${String(e)}`);
        }
      },
    },
    {
      name: "agent_status",
      description:
        "Get the status of all active agents, or a specific agent by ID.",
      parameters: {
        type: "object",
        properties: {
          agent_id: { type: "string", description: "Optional agent ID. Omit to list all." },
        },
        required: [],
      },
      async execute(args) {
        try {
          const handler = Handler.getInstance();
          const result = handler.getAgentStatus(
            args.agent_id ? String(args.agent_id) : undefined
          );

          if (Array.isArray(result)) {
            if (result.length === 0) return ok("No active agents.");
            const lines = result.map(
              (s) =>
                `${s.id} [${s.role}] "${s.name}" - ${s.status}` +
                (s.currentTask ? ` | Task: ${s.currentTask}` : "") +
                ` | ${s.outputLines} lines | ${(s.elapsed / 1000).toFixed(1)}s`
            );
            return ok(lines.join("\n"));
          }

          const s = result;
          return ok(
            `ID: ${s.id}\n` +
            `Name: ${s.name}\n` +
            `Role: ${s.role}\n` +
            `Status: ${s.status}\n` +
            `Task: ${s.currentTask ?? "(none)"}\n` +
            `Progress: ${s.progress}%\n` +
            `Output lines: ${s.outputLines}\n` +
            `Elapsed: ${(s.elapsed / 1000).toFixed(1)}s\n` +
            `Tokens used: ${s.tokensUsed}`
          );
        } catch (e) {
          return err(`Failed to get status: ${String(e)}`);
        }
      },
    },
    {
      name: "agent_output",
      description: "Get recent output from a specific agent.",
      parameters: {
        type: "object",
        properties: {
          agent_id: { type: "string", description: "ID of the agent" },
          tail: { type: "number", description: "Number of recent lines to return (default 50)" },
        },
        required: ["agent_id"],
      },
      async execute(args) {
        try {
          const handler = Handler.getInstance();
          const output = handler.getAgentOutput(String(args.agent_id));
          const tail = args.tail ? Number(args.tail) : 50;
          const lines = output.slice(-tail);
          if (lines.length === 0) return ok("No output yet.");
          return ok(lines.join("\n"));
        } catch (e) {
          return err(`Failed to get output: ${String(e)}`);
        }
      },
    },
    {
      name: "agent_message",
      description: "Send a message or instruction to a specific running agent.",
      parameters: {
        type: "object",
        properties: {
          agent_id: { type: "string", description: "ID of the agent" },
          message: { type: "string", description: "Message to send" },
        },
        required: ["agent_id", "message"],
      },
      async execute(args) {
        try {
          const handler = Handler.getInstance();
          handler.messageAgent(String(args.agent_id), String(args.message));
          // Also emit event to unblock paused agents waiting for user input
          const eventBus = EventBus.getInstance();
          eventBus.emit("handler:agent-user-input", {
            agentId: String(args.agent_id),
            message: String(args.message),
          });
          return ok(`Message sent to ${args.agent_id}.`);
        } catch (e) {
          return err(`Failed to message agent: ${String(e)}`);
        }
      },
    },
    {
      name: "delegate",
      description:
        "Analyze a complex goal and automatically spawn the right agents to accomplish it. " +
        "Returns a plan with the spawned agents and their assigned tasks.",
      parameters: {
        type: "object",
        properties: {
          goal: { type: "string", description: "The high-level goal to accomplish" },
        },
        required: ["goal"],
      },
      async execute(args) {
        try {
          const handler = Handler.getInstance();
          const result = handler.delegateTask(String(args.goal));
          const agentLines = result.agents.map(
            (a) => `  ${a.id} [${a.role}] "${a.name}" -> ${a.currentTask}`
          );
          return ok(
            `Plan ${result.planId} created with ${result.agents.length} agent(s):\n` +
            agentLines.join("\n") +
            "\n\nTasks:\n" +
            result.tasks.map((t, i) => `  ${i + 1}. ${t}`).join("\n")
          );
        } catch (e) {
          return err(`Failed to delegate: ${String(e)}`);
        }
      },
    },
  ];
}
