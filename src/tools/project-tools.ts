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
import { ProjectStore, type Project } from "../agent-store/index.js";
import { readProjectBrief, updateProjectBrief } from "../memory/project-brief.js";

function ok(content: string): ToolResult { return { content }; }
function err(content: string): ToolResult { return { content, isError: true }; }

/** Resolve a project by id (proj-...) or case-insensitive name. Lets the
 *  brief tools accept whichever the model has on hand — it usually knows the
 *  name, not the id. */
function resolveProject(ref: string): Project | null {
  const store = ProjectStore.getInstance();
  return store.get(ref) ?? store.findByName(ref);
}

/** Broadcast a "projects_changed" event so any open client refreshes
 *  its Projects sidebar / agent-page list. Mirrors the
 *  sidebar_pins_changed / settings_changed pattern used by
 *  src/app-tools/sidebar.ts and src/tools/setting-tool.ts. Best-effort:
 *  swallow errors so a missing WS context doesn't fail the tool call. */
async function broadcastProjectsChanged(): Promise<void> {
  try {
    const { broadcastAll } = await import("../chat-ws/index.js");
    broadcastAll({ type: "projects_changed" });
  } catch { /* no WS context (e.g. test) — tool itself still succeeded */ }
}

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
        "in the list). Pass `summary` to seed the project brief, then interview the " +
        "user to flesh it out — the brief becomes the shared context every agent reads.",
      parameters: {
        type: "object",
        properties: {
          name: { type: "string", description: "Project display name (e.g. 'Nutrishop McKinney')" },
          description: { type: "string", description: "One-line description" },
          summary: {
            type: "string",
            description:
              "Optional paragraph on what this project/business is about — goals, " +
              "what it does, current state. Seeds the project brief. After creating, " +
              "interview the user to flesh it out (the tool result will remind you).",
          },
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
          const store = ProjectStore.getInstance();

          // Idempotent on name. Two reasons:
          //  1. User policy: project names are unique (case-insensitive).
          //  2. The Anthropic CLI/MCP path loops project_create when its
          //     own text reply phrases the result as a pending question
          //     ("want me to add agents?"). Returning the EXISTING project
          //     with an explicit "already exists" body breaks that loop —
          //     the model stops re-issuing "Created project ..." because
          //     the tool result no longer reads like fresh work.
          const existing = store.findByName(name);
          if (existing) {
            return ok(
              `Project '${existing.name}' already exists (id: ${existing.id}). ` +
              `Nothing was created. To add agents, call project_add_agent with project_id=${existing.id}. ` +
              `If you intended a separate project, retry with a distinct name (e.g. '${name} 2' or '${name} McKinney').`,
            );
          }

          const project = store.create({
            name,
            description: args.description ? String(args.description) : "",
            agentIds,
            workspace: args.workspace ? String(args.workspace) : undefined,
            secretKeys: Array.isArray(args.secret_keys) ? args.secret_keys.map(String) : undefined,
            allowedTools: Array.isArray(args.allowed_tools) ? args.allowed_tools.map(String) : undefined,
          });
          await seedRosters(project.id, agentIds);

          // Seed the brief from the summary. Best-effort: a failed brief write
          // must not fail project creation (the project already exists).
          const summary = args.summary ? String(args.summary).trim() : "";
          if (summary) {
            try {
              await updateProjectBrief(project.id, `## Overview\n${summary}`, { title: project.name });
            } catch (e) {
              // swallow — project is created; brief can be filled in later
              void e;
            }
          }

          await broadcastProjectsChanged();
          const rosterLine = agentIds.length > 0
            ? ` Seeded roster: ${agentIds.length} agent(s).`
            : ` Roster is empty; call project_add_agent to populate it.`;
          const briefLine = summary ? ` Brief started from your summary.` : "";
          // Drive the onboarding interview: the model runs it in its normal
          // conversation loop, recording answers via project_brief_update. The
          // brief is the project's shared source of truth for every agent.
          const interviewLine =
            ` Now interview the user to build the brief — ask a few clarifying questions` +
            ` (goals, current state, key products/people, success metrics, constraints),` +
            ` a couple at a time, and record each answer with project_brief_update` +
            ` (project='${project.name}'). Keep it conversational, not a form.`;
          return ok(`Created project '${project.name}' (id: ${project.id}).${rosterLine}${briefLine}${interviewLine}`);
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
        await broadcastProjectsChanged();
        return ok(`Added ${agentId} to ${project.name} (id: ${projectId}).`);
      },
    },

    {
      name: "project_brief_read",
      description:
        "Read a project's living brief — the evolving narrative of what the project is, " +
        "its goals, current state, and decisions. Use this to answer questions about a " +
        "project ('what's the latest on X?') without being scoped into it, or to get up " +
        "to speed before working on one. Briefs are shared and readable across the whole " +
        "system — you never need to be 'in' the project to read it.",
      parameters: {
        type: "object",
        properties: {
          project: { type: "string", description: "Project name or id (proj-...)" },
        },
        required: ["project"],
      },
      async execute(args) {
        const ref = String(args.project ?? "").trim();
        if (!ref) return err("project_brief_read requires a `project` (name or id).");
        const project = resolveProject(ref);
        if (!project) return err(`Project not found: ${ref}. Use project_list to see available projects.`);
        const brief = await readProjectBrief(project.id);
        if (!brief) {
          return ok(
            `'${project.name}' has no brief yet. It gets written as agents record what the ` +
            `project is and what's happening — use project_brief_update to start it.`,
          );
        }
        return ok(`Brief for '${project.name}':\n\n${brief}`);
      },
    },

    {
      name: "project_brief_update",
      description:
        "Record something into a project's living brief — a change in goals, a decision, a " +
        "new fact about the business, a status shift. Any agent on the project can update " +
        "it; the brief is the shared source of truth other agents read. Pass markdown for " +
        "just the part you're adding or correcting (e.g. a '## Competitors' section) — it's " +
        "merged into the brief, and a repeated heading replaces its old version so the brief " +
        "stays current instead of piling up. Keep it concise and factual.",
      parameters: {
        type: "object",
        properties: {
          project: { type: "string", description: "Project name or id (proj-...)" },
          content: { type: "string", description: "Markdown to merge into the brief (a section or corrected fact)" },
        },
        required: ["project", "content"],
      },
      async execute(args) {
        const ref = String(args.project ?? "").trim();
        const content = String(args.content ?? "").trim();
        if (!ref) return err("project_brief_update requires a `project` (name or id).");
        if (!content) return err("project_brief_update requires non-empty `content`.");
        const project = resolveProject(ref);
        if (!project) return err(`Project not found: ${ref}. Use project_list to see available projects.`);
        try {
          await updateProjectBrief(project.id, content, { title: project.name });
          return ok(`Updated brief for '${project.name}'.`);
        } catch (e) {
          return err(`Failed to update brief: ${String(e)}`);
        }
      },
    },
  ];
}
