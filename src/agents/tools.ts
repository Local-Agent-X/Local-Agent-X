/**
 * Tool surface for the canonical agent layer.
 *
 * Three primitives — the only way a delegating agent (main agent in
 * chat, CEO inside a project, any agent with delegation rights) talks
 * to the catalog and the runtime:
 *
 *   agent_list     - what agents I can delegate to (scope-filtered)
 *   agent_spawn    - invoke an agent from the catalog
 *   agent_create   - extend the catalog with a new agent definition
 *
 * agent_spawn's old ad-hoc shape ({name, role, systemPrompt, tools,
 * task}) is intentionally gone. Callers must reference a catalog entry
 * by id ("builtin-researcher", "tpl-...") or role slug ("researcher").
 * The "I just need an anonymous worker for one task" escape hatch is
 * killed by design — extend the catalog (or use the generic "worker"
 * role) instead. See docs/canonical-agent-design.md Q1.
 */

import type { ToolDefinition, ToolResult } from "../types.js";
import type { InvokeScope } from "./types.js";
import { AgentCatalog } from "./catalog.js";
import { invokeAgent, awaitAgentRunning, AgentNotFoundError } from "./invoke.js";
import { Handler } from "../agency/handler.js";
import { AgentTemplateStore } from "../agent-store/index.js";

function ok(content: string): ToolResult { return { content }; }
function err(content: string): ToolResult { return { content, isError: true }; }

function parseScope(args: Record<string, unknown>): InvokeScope | undefined {
  const projectId = args.project_id ?? args.projectId;
  return projectId ? { projectId: String(projectId) } : undefined;
}

export function createAgentTools(): ToolDefinition[] {
  return [
    {
      name: "agent_list",
      description:
        "List the agents you can delegate to. Returns name, role, " +
        "description, and id for each agent on your roster. Use this " +
        "BEFORE agent_spawn so you pick a real catalog entry rather " +
        "than inventing a role. Optionally scope to a project's " +
        "roster via project_id.",
      parameters: {
        type: "object",
        properties: {
          project_id: { type: "string", description: "Optional project id to scope the catalog to that project's roster" },
        },
        required: [],
      },
      async execute(args) {
        const scope = parseScope(args);
        const defs = AgentCatalog.getInstance().list(scope);
        if (defs.length === 0) {
          return ok(scope
            ? `No agents on the roster for project ${scope.projectId}. Use agent_create to add one, or hire from the global catalog via the Agents page.`
            : `Catalog is empty.`);
        }
        // Display order: managers first (CEO and managerial roles drive
        // delegation hierarchies), specialists next (alphabetical by role),
        // generic Worker last. The catalog's underlying order is by
        // recency of update — that's wrong for a discovery list because
        // the most-recently-added agent (often the generic Worker or a
        // user-created template) gets surfaced ahead of every specialist
        // a human or LLM is actually looking for.
        const orderBucket = (role: string): number => {
          if (role === "ceo") return 0;
          if (role === "worker") return 2;
          return 1;
        };
        const sorted = [...defs].sort((a, b) => {
          const ab = orderBucket(a.role);
          const bb = orderBucket(b.role);
          if (ab !== bb) return ab - bb;
          return a.role.localeCompare(b.role);
        });
        const lines = sorted.map((d) => `${d.icon || "•"} ${d.name} (role: ${d.role}, id: ${d.id}) — ${d.description}`);
        return ok(`${sorted.length} agent(s) available:\n\n${lines.join("\n")}`);
      },
    },

    {
      name: "agent_spawn",
      description:
        "Invoke an agent from the catalog on a task. The agent runs " +
        "asynchronously and reports back when done. You MUST pass a " +
        "real catalog entry — either a canonical id (e.g. " +
        "'builtin-researcher', 'tpl-...') or a role slug (e.g. " +
        "'researcher'). Use agent_list first if you don't know what's " +
        "available. If no fitting agent exists, use agent_create to " +
        "add one, then spawn it. Inline ad-hoc spawns are not " +
        "supported — the catalog is the source of truth.",
      parameters: {
        type: "object",
        properties: {
          agent: { type: "string", description: "Canonical agent id OR role slug" },
          task: { type: "string", description: "The task for the agent to perform" },
          project_id: { type: "string", description: "Optional project id to scope the lookup + apply project tool gating" },
          name_override: { type: "string", description: "Optional run-specific display name" },
        },
        required: ["agent", "task"],
      },
      async execute(args) {
        try {
          const sessionFromArgs = args._sessionId ? String(args._sessionId) : undefined;
          const ref = invokeAgent(
            String(args.agent),
            String(args.task),
            {
              parentSessionId: sessionFromArgs,
              scope: parseScope(args),
              nameOverride: args.name_override ? String(args.name_override) : undefined,
            },
          );
          // Lifecycle verification: invokeAgent void-fires runAgentViaDriver.
          // A crash during driver init (provider misconfig, missing
          // credentials, malformed system prompt) flips the FieldAgent to
          // status="failed" via finalizeExternalRun but never surfaced to
          // the caller before this check. Watch for the failure within 5s;
          // success path is unchanged.
          const reached = await awaitAgentRunning(ref.runId, 5000);
          if (!reached.running) {
            return err(`Agent spawn did not reach running state: ${reached.reason}`);
          }
          const status = Handler.getInstance().getAgentStatus(ref.runId);
          if (Array.isArray(status)) return ok(`Agent spawned: ${ref.runId}`);
          return ok(
            `Agent spawned: ${ref.runId}\n` +
            `Name: ${status.name}\n` +
            `Role: ${ref.definition.role} (id: ${ref.definition.id})\n` +
            `Task: ${status.currentTask}\n` +
            `Status: ${status.status}`,
          );
        } catch (e) {
          if (e instanceof AgentNotFoundError) return err(e.message);
          return err(`Failed to spawn agent: ${String(e)}`);
        }
      },
    },

    {
      name: "agent_create",
      description:
        "Add a new agent to the catalog. Use this when no existing " +
        "agent fits a recurring need (do NOT create one-offs — for " +
        "throwaway tasks, use the generic 'worker' role). The new " +
        "agent appears in the catalog and is invocable via " +
        "agent_spawn. Required: name, role, system_prompt, " +
        "allowed_tools. The user can see, edit, or trash any " +
        "agent you create.",
      parameters: {
        type: "object",
        properties: {
          name: { type: "string", description: "Display name (e.g. 'Compliance Reviewer')" },
          role: { type: "string", description: "Lowercase role slug (e.g. 'compliance-reviewer')" },
          system_prompt: { type: "string", description: "The agent's load-bearing instructions" },
          allowed_tools: { type: "array", items: { type: "string" }, description: "Tool names this agent may call" },
          description: { type: "string", description: "One-line description for pickers and lists" },
          icon: { type: "string", description: "Optional emoji or short icon" },
        },
        required: ["name", "role", "system_prompt", "allowed_tools"],
      },
      async execute(args) {
        try {
          const tools = Array.isArray(args.allowed_tools) ? args.allowed_tools.map(String) : [];
          if (tools.length === 0) return err(`allowed_tools must be a non-empty list of tool names.`);
          const name = String(args.name).trim();
          const store = AgentTemplateStore.getInstance();
          const existing = store.findByName(name);
          if (existing) {
            return ok(
              `Agent '${existing.name}' already exists (id: ${existing.id}, role: ${existing.role}). ` +
              `Nothing was created. To spawn an instance use agent_spawn with template_id=${existing.id}. ` +
              `If you intended a distinct agent, retry with a different name.`,
            );
          }
          const template = store.create({
            name,
            role: String(args.role),
            systemPrompt: String(args.system_prompt),
            allowedTools: tools,
            description: String(args.description || `Agent for role ${args.role}`),
            icon: args.icon ? String(args.icon) : undefined,
          });
          return ok(
            `Created agent: ${template.name} (id: ${template.id}, role: ${template.role}).\n` +
            `Available via agent_spawn. Tools: ${template.allowedTools.join(", ")}.`,
          );
        } catch (e) {
          return err(`Failed to create agent: ${String(e)}`);
        }
      },
    },
  ];
}
