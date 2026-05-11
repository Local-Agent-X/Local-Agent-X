import { EventBus } from "../event-bus.js";
import type { ToolDefinition, ToolResult } from "../types.js";

import { Handler } from "./handler.js";

function ok(content: string): ToolResult {
  return { content };
}

function err(content: string): ToolResult {
  return { content, isError: true };
}

export function createHandlerTools(): ToolDefinition[] {
  return [
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
            args.agent_id ? String(args.agent_id) : undefined,
          );

          if (Array.isArray(result)) {
            if (result.length === 0) return ok("No active agents.");
            const lines = result.map(
              (s) =>
                `${s.id} [${s.role}] "${s.name}" - ${s.status}` +
                (s.currentTask ? ` | Task: ${s.currentTask}` : "") +
                ` | ${s.outputLines} lines | ${(s.elapsed / 1000).toFixed(1)}s`,
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
            `Tokens used: ${s.tokensUsed}`,
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
            (a) => `  ${a.id} [${a.role}] "${a.name}" -> ${a.currentTask}`,
          );
          return ok(
            `Plan ${result.planId} created with ${result.agents.length} agent(s):\n` +
            agentLines.join("\n") +
            "\n\nTasks:\n" +
            result.tasks.map((t, i) => `  ${i + 1}. ${t}`).join("\n"),
          );
        } catch (e) {
          return err(`Failed to delegate: ${String(e)}`);
        }
      },
    },
  ];
}
