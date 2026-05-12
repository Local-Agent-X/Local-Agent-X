// Agency System -- Multi-agent orchestration for complex goals

import type { ToolDefinition, ToolResult } from "../types.js";
import type { AgencyConfig, AgencyResult, AgencyStatus } from "./types.js";
import { AgencyOrchestrator } from "./agency-orchestrator.js";
import { listRoles } from "./agent-roles.js";
import { AgentCatalog } from "../agents/catalog.js";
import { EventBus } from "../event-bus.js";

// Re-export all modules
export * from "./types.js";
export * from "./handler.js";
export * from "./agency-orchestrator.js";
export * from "./message-bus.js";
export * from "./agent-roles.js";
export * from "./planner.js";

// Active agency registry
const activeOperations = new Map<string, { orchestrator: AgencyOrchestrator; result?: AgencyResult }>();

const DEFAULT_CONFIG: AgencyConfig = {
  maxAgents: 10,
  maxConcurrent: 5,
  timeout: 120_000,
  provider: "openai",
  model: "gpt-4o",
};

/**
 * Convenience function: create a agency, plan it, and execute it.
 */
export async function createOperation(
  goal: string,
  config?: Partial<AgencyConfig>
): Promise<AgencyResult> {
  const merged: AgencyConfig = { ...DEFAULT_CONFIG, ...config };
  const orchestrator = new AgencyOrchestrator(merged);
  const plan = orchestrator.planOperation(goal);

  activeOperations.set(plan.id, { orchestrator });

  await EventBus.emit("agency:created", { planId: plan.id, goal });

  const result = await orchestrator.executeOperation(plan);
  activeOperations.set(plan.id, { orchestrator, result });

  return result;
}

function ok(content: string): ToolResult {
  return { content };
}

function err(content: string): ToolResult {
  return { content, isError: true };
}

/**
 * Returns tool definitions for the agent to manage agencys.
 */
export function createAgencyTools(): ToolDefinition[] {
  return [
    {
      name: "agency_create",
      description:
        "Create and execute a new agent operation to accomplish a complex goal. " +
        "The goal is automatically decomposed into tasks, assigned to specialized agents, " +
        "and executed with dependency management.",
      parameters: {
        type: "object",
        properties: {
          goal: {
            type: "string",
            description: "The high-level goal for the agency to accomplish",
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
          const config: Partial<AgencyConfig> = {};
          if (args.max_agents) config.maxAgents = Number(args.max_agents);
          if (args.max_concurrent) config.maxConcurrent = Number(args.max_concurrent);
          if (args.timeout) config.timeout = Number(args.timeout);
          if (args.provider) config.provider = String(args.provider);
          if (args.model) config.model = String(args.model);

          const result = await createOperation(String(args.goal), config);
          return ok(
            `Agency ${result.planId} ${result.success ? "completed" : "failed"}.\n\n` +
            `Tasks: ${result.results.size} completed\n` +
            `Tokens: ${result.tokensUsed}\n` +
            `Time: ${(result.elapsed / 1000).toFixed(1)}s\n\n` +
            `Summary:\n${result.summary}`
          );
        } catch (e) {
          return err(`Failed to create agency: ${String(e)}`);
        }
      },
    },
    {
      name: "agency_status",
      description: "Check the status of a running or completed agency.",
      parameters: {
        type: "object",
        properties: {
          plan_id: {
            type: "string",
            description: "The plan ID to check. Omit to list all active agencys.",
          },
        },
        required: [],
      },
      async execute(args) {
        if (args.plan_id) {
          const entry = activeOperations.get(String(args.plan_id));
          if (!entry) return err(`Agency ${args.plan_id} not found.`);
          const status = entry.orchestrator.getStatus();
          return ok(formatOpStatus(status));
        }

        // List all
        if (activeOperations.size === 0) return ok("No active operations.");
        const lines: string[] = [];
        for (const [id, entry] of activeOperations) {
          const s = entry.orchestrator.getStatus();
          lines.push(`${id}: ${s.status} - ${s.goal} (${s.tasksCompleted}/${s.tasks.length} tasks)`);
        }
        return ok(lines.join("\n"));
      },
    },
    {
      name: "agency_cancel",
      description: "Cancel a running agency.",
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
        const entry = activeOperations.get(String(args.plan_id));
        if (!entry) return err(`Agency ${args.plan_id} not found.`);
        entry.orchestrator.cancelOperation();
        return ok(`Agency ${args.plan_id} cancelled.`);
      },
    },
    {
      name: "agency_list_roles",
      description: "List all available agent roles for agency agents.",
      parameters: {
        type: "object",
        properties: {},
        required: [],
      },
      async execute() {
        // Route through the canonical catalog so this tool sees the
        // same agents the chat-side agent_spawn sees — including
        // user-created templates, not just BUILT_IN_ROLES.
        const defs = AgentCatalog.getInstance().list();
        const lines = defs.map(
          (d) => `${d.role}: ${d.description}\n  Tools: ${d.allowedTools.join(", ")}`,
        );
        return ok(lines.join("\n\n"));
      },
    },
    {
      name: "agency_result",
      description: "Get the final result of a completed agency.",
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
        const entry = activeOperations.get(String(args.plan_id));
        if (!entry) return err(`Agency ${args.plan_id} not found.`);
        if (!entry.result) return err(`Agency ${args.plan_id} has not completed yet.`);

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

function formatOpStatus(s: AgencyStatus): string {
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
