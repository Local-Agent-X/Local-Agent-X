// Swarm System -- Multi-agent orchestration for complex goals

import type { ToolDefinition, ToolResult } from "../types.js";
import type { SwarmConfig, SwarmResult, SwarmStatus } from "./types.js";
import { SwarmOrchestrator } from "./orchestrator.js";
import { listRoles } from "./agent-roles.js";
import { EventBus } from "../event-bus.js";

// Re-export all modules
export * from "./types.js";
export * from "./orchestrator.js";
export * from "./message-bus.js";
export * from "./agent-roles.js";
export * from "./planner.js";

// Active swarm registry
const activeSwarms = new Map<string, { orchestrator: SwarmOrchestrator; result?: SwarmResult }>();

const DEFAULT_CONFIG: SwarmConfig = {
  maxAgents: 10,
  maxConcurrent: 5,
  timeout: 120_000,
  provider: "openai",
  model: "gpt-4o",
};

/**
 * Convenience function: create a swarm, plan it, and execute it.
 */
export async function createSwarm(
  goal: string,
  config?: Partial<SwarmConfig>
): Promise<SwarmResult> {
  const merged: SwarmConfig = { ...DEFAULT_CONFIG, ...config };
  const orchestrator = new SwarmOrchestrator(merged);
  const plan = orchestrator.planSwarm(goal);

  activeSwarms.set(plan.id, { orchestrator });

  await EventBus.emit("swarm:created", { planId: plan.id, goal });

  const result = await orchestrator.executeSwarm(plan);
  activeSwarms.set(plan.id, { orchestrator, result });

  return result;
}

function ok(content: string): ToolResult {
  return { content };
}

function err(content: string): ToolResult {
  return { content, isError: true };
}

/**
 * Returns tool definitions for the agent to manage swarms.
 */
export function createSwarmTools(): ToolDefinition[] {
  return [
    {
      name: "swarm_create",
      description:
        "Create and execute a new agent swarm to accomplish a complex goal. " +
        "The goal is automatically decomposed into tasks, assigned to specialized agents, " +
        "and executed with dependency management.",
      parameters: {
        type: "object",
        properties: {
          goal: {
            type: "string",
            description: "The high-level goal for the swarm to accomplish",
          },
          max_agents: {
            type: "number",
            description: "Maximum number of agents (default 10)",
          },
          max_concurrent: {
            type: "number",
            description: "Maximum concurrent tasks (default 5)",
          },
          timeout: {
            type: "number",
            description: "Timeout per task in milliseconds (default 120000)",
          },
          provider: {
            type: "string",
            description: "LLM provider to use (default: openai)",
          },
          model: {
            type: "string",
            description: "Model to use (default: gpt-4o)",
          },
        },
        required: ["goal"],
      },
      async execute(args) {
        try {
          const config: Partial<SwarmConfig> = {};
          if (args.max_agents) config.maxAgents = Number(args.max_agents);
          if (args.max_concurrent) config.maxConcurrent = Number(args.max_concurrent);
          if (args.timeout) config.timeout = Number(args.timeout);
          if (args.provider) config.provider = String(args.provider);
          if (args.model) config.model = String(args.model);

          const result = await createSwarm(String(args.goal), config);
          return ok(
            `Swarm ${result.planId} ${result.success ? "completed" : "failed"}.\n\n` +
            `Tasks: ${result.results.size} completed\n` +
            `Tokens: ${result.tokensUsed}\n` +
            `Time: ${(result.elapsed / 1000).toFixed(1)}s\n\n` +
            `Summary:\n${result.summary}`
          );
        } catch (e) {
          return err(`Failed to create swarm: ${String(e)}`);
        }
      },
    },
    {
      name: "swarm_status",
      description: "Check the status of a running or completed swarm.",
      parameters: {
        type: "object",
        properties: {
          plan_id: {
            type: "string",
            description: "The plan ID to check. Omit to list all active swarms.",
          },
        },
        required: [],
      },
      async execute(args) {
        if (args.plan_id) {
          const entry = activeSwarms.get(String(args.plan_id));
          if (!entry) return err(`Swarm ${args.plan_id} not found.`);
          const status = entry.orchestrator.getStatus();
          return ok(formatStatus(status));
        }

        // List all
        if (activeSwarms.size === 0) return ok("No active swarms.");
        const lines: string[] = [];
        for (const [id, entry] of activeSwarms) {
          const s = entry.orchestrator.getStatus();
          lines.push(`${id}: ${s.status} - ${s.goal} (${s.tasksCompleted}/${s.tasks.length} tasks)`);
        }
        return ok(lines.join("\n"));
      },
    },
    {
      name: "swarm_cancel",
      description: "Cancel a running swarm.",
      parameters: {
        type: "object",
        properties: {
          plan_id: {
            type: "string",
            description: "The plan ID to cancel",
          },
        },
        required: ["plan_id"],
      },
      async execute(args) {
        const entry = activeSwarms.get(String(args.plan_id));
        if (!entry) return err(`Swarm ${args.plan_id} not found.`);
        entry.orchestrator.cancelSwarm();
        return ok(`Swarm ${args.plan_id} cancelled.`);
      },
    },
    {
      name: "swarm_list_roles",
      description: "List all available agent roles for swarm agents.",
      parameters: {
        type: "object",
        properties: {},
        required: [],
      },
      async execute() {
        const roles = listRoles();
        const lines = roles.map(
          (r) => `${r.name}: ${r.description}\n  Tools: ${r.suggestedTools.join(", ")}`
        );
        return ok(lines.join("\n\n"));
      },
    },
    {
      name: "swarm_result",
      description: "Get the final result of a completed swarm.",
      parameters: {
        type: "object",
        properties: {
          plan_id: {
            type: "string",
            description: "The plan ID to get results for",
          },
        },
        required: ["plan_id"],
      },
      async execute(args) {
        const entry = activeSwarms.get(String(args.plan_id));
        if (!entry) return err(`Swarm ${args.plan_id} not found.`);
        if (!entry.result) return err(`Swarm ${args.plan_id} has not completed yet.`);

        const r = entry.result;
        return ok(
          `Goal: ${r.goal}\n` +
          `Success: ${r.success}\n` +
          `Tokens: ${r.tokensUsed}\n` +
          `API Calls: ${r.apiCalls}\n` +
          `Time: ${(r.elapsed / 1000).toFixed(1)}s\n\n` +
          `Summary:\n${r.summary}`
        );
      },
    },
  ];
}

function formatStatus(s: SwarmStatus): string {
  const lines = [
    `Plan: ${s.planId}`,
    `Goal: ${s.goal}`,
    `Status: ${s.status}`,
    `Tasks: ${s.tasksCompleted} done, ${s.tasksFailed} failed, ${s.tasksRemaining} remaining`,
    `Tokens: ${s.tokensUsed}`,
    `API Calls: ${s.apiCalls}`,
    `Elapsed: ${(s.elapsed / 1000).toFixed(1)}s`,
    "",
    "Agents:",
  ];

  for (const a of s.agents) {
    lines.push(`  ${a.name} [${a.role}]: ${a.status}${a.currentTask ? ` (task: ${a.currentTask})` : ""}`);
  }

  lines.push("", "Tasks:");
  for (const t of s.tasks) {
    const deps = t.dependsOn.length > 0 ? ` (depends: ${t.dependsOn.join(", ")})` : "";
    lines.push(`  ${t.id}: ${t.status} - ${t.description}${deps}`);
  }

  return lines.join("\n");
}
