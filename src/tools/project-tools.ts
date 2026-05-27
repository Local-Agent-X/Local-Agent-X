// Project tools — agent-facing CRUD for Projects.
//
// Projects are containers for agent rosters + secret/tool scopes. The
// HTTP API at /api/projects has always existed (see
// src/routes/agents/projects.ts), but no agent-facing tool wrapped it,
// so a delegating agent asked to "create a project" had no path other
// than http_request. Live failure 2026-05-27 (sess=chat-mpoah96): the
// agent created custom templates via agent_create and called those the
// "project", looping on `remember` 13 times to rationalize the gap.
//
// These tools mirror the route handler's seedProjectRosters behavior
// so a tool-created project ends up shaped identically to one created
// from the Agents page.
//
// Lives outside src/agents/tools.ts on purpose: that file's contract
// is "the three primitives an agent uses to talk to the catalog"
// (agent_list / agent_spawn / agent_create). Projects are containers
// for those primitives, not primitives themselves.

import type { ToolDefinition, ToolResult } from "../types.js";
import { ProjectStore } from "../agent-store.js";

function ok(content: string): ToolResult { return { content }; }
function err(content: string): ToolResult { return { content, isError: true }; }

/** Mirror of seedProjectRosters in src/routes/agents/projects.ts so a
 *  tool-created project ends up shaped identically to one created via
 *  the HTTP API. CEO-led trees auto-wire reportsTo so the org chart
 *  isn't flat by default. */
async function seedRosters(projectId: string, agentIds: string[]): Promise<void> {
  if (agentIds.length === 0) return;
  const { ProjectRosterStore } = await import("../project-rosters.js");
  const rosterStore = ProjectRosterStore.getInstance();
  const projectStore = ProjectStore.getInstance();
  const hasCeo = agentIds.includes("builtin-ceo");
  for (const agentId of agentIds) {
    rosterStore.upsert(projectId, agentId, {
      reportsTo: (hasCeo && agentId !== "builtin-ceo") ? "builtin-ceo" : undefined,
    });
    projectStore.addAgent(projectId, agentId);
  }
}

export function createProjectTools(): ToolDefinition[] {
  return [
    {
      name: "project_create",
      description:
        "Create a new project (organization-scoped container for a roster of agents). " +
        "Use this when the user asks to set up a project, organization, company, team, " +
        "or workspace for a group of agents to collaborate in. The project shows up in " +
        "the Agents page Projects tab; agents added to it can be scoped via project_id " +
        "on agent_list / agent_spawn. Optionally seed with agent template ids — they " +
        "become real roster entries (with CEO-led reportsTo wiring when builtin-ceo is " +
        "in the list).",
      parameters: {
        type: "object",
        properties: {
          name: { type: "string", description: "Project display name (e.g. 'Nutrishop McKinney')" },
          description: { type: "string", description: "One-line description" },
          agent_ids: {
            type: "array",
            items: { type: "string" },
            description: "Optional agent template ids to seed on the roster (e.g. ['builtin-ceo', 'tpl-...'])",
          },
          workspace: { type: "string", description: "Optional project-specific workspace directory" },
          secret_keys: {
            type: "array",
            items: { type: "string" },
            description: "Optional secret keys this project's agents can access",
          },
          allowed_tools: {
            type: "array",
            items: { type: "string" },
            description: "Optional tool name restrictions for this project's agents",
          },
        },
        required: ["name"],
      },
      async execute(args) {
        try {
          const name = String(args.name).trim();
          if (!name) return err("project_create requires a non-empty `name`.");
          const agentIds = Array.isArray(args.agent_ids) ? args.agent_ids.map(String) : [];
          const project = ProjectStore.getInstance().create({
            name,
            description: args.description ? String(args.description) : "",
            agentIds,
            workspace: args.workspace ? String(args.workspace) : undefined,
            secretKeys: Array.isArray(args.secret_keys) ? args.secret_keys.map(String) : undefined,
            allowedTools: Array.isArray(args.allowed_tools) ? args.allowed_tools.map(String) : undefined,
          });
          await seedRosters(project.id, agentIds);
          const rosterLine = agentIds.length > 0
            ? `\nSeeded roster: ${agentIds.length} agent(s).`
            : `\nRoster is empty — add agents via project_add_agent or seed agent_ids on the next call.`;
          return ok(`Created project: ${project.name} (id: ${project.id}).${rosterLine}`);
        } catch (e) {
          return err(`Failed to create project: ${String(e)}`);
        }
      },
    },

    {
      name: "project_list",
      description:
        "List projects with their ids, names, and roster sizes. Use BEFORE project_add_agent " +
        "or before scoping agent_list/agent_spawn with project_id, so you reference a real " +
        "project rather than a made-up id.",
      parameters: { type: "object", properties: {}, required: [] },
      async execute() {
        const projects = ProjectStore.getInstance().list();
        if (projects.length === 0) return ok("No projects yet. Use project_create to add one.");
        const lines = projects.map((p) =>
          `• ${p.name} (id: ${p.id}) — ${p.agentIds.length} agent(s)${p.description ? ` — ${p.description}` : ""}`,
        );
        return ok(`${projects.length} project(s):\n\n${lines.join("\n")}`);
      },
    },

    {
      name: "project_add_agent",
      description:
        "Add an existing agent (by template id) to a project's roster. Idempotent. " +
        "Use after project_create when you didn't seed the roster up front, or to grow " +
        "the team later. The agent becomes visible to agent_list / agent_spawn when " +
        "scoped via project_id.",
      parameters: {
        type: "object",
        properties: {
          project_id: { type: "string", description: "Target project id (proj-...)" },
          agent_id: { type: "string", description: "Agent template id (builtin-... or tpl-...)" },
        },
        required: ["project_id", "agent_id"],
      },
      async execute(args) {
        const projectId = String(args.project_id);
        const agentId = String(args.agent_id);
        const project = ProjectStore.getInstance().get(projectId);
        if (!project) return err(`Project not found: ${projectId}. Use project_list to see available projects.`);
        await seedRosters(projectId, [agentId]);
        return ok(`Added ${agentId} to ${project.name} (id: ${projectId}).`);
      },
    },
  ];
}
