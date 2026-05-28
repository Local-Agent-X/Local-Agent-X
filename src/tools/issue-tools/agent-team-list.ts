import type { ToolDefinition } from "../../types.js";
import { AgentTemplateStore } from "../../agent-store.js";
import { ProjectRosterStore } from "../../project-rosters.js";
import { ok } from "./shared.js";

export const agentTeamListTool: ToolDefinition = {
  name: "agent_team_list",
  description:
    "List agents on the team. Without projectId, lists every rostered " +
    "agent across all projects (no heartbeat/reportsTo info — those " +
    "are per-project). With projectId, lists that project's roster " +
    "with the project-scoped hierarchy and heartbeat info.",
  parameters: {
    type: "object",
    properties: {
      projectId: { type: "string", description: "Optional — scope listing + render reportsTo / heartbeat for this project's roster" },
    },
  },
  async execute(args) {
    const store = AgentTemplateStore.getInstance();
    const rosterStore = ProjectRosterStore.getInstance();
    const projectId = args.projectId ? String(args.projectId) : undefined;

    if (projectId) {
      const rosters = rosterStore.listByProject(projectId);
      if (rosters.length === 0) return ok(`No agents on the roster for project ${projectId}.`);
      const lines = rosters.map((r) => {
        const tpl = store.get(r.agentId);
        if (!tpl) return null;
        return `${tpl.icon || "•"} ${tpl.name} (${tpl.role})${r.heartbeatEnabled ? ` | Heartbeat: ${r.heartbeatSchedule}` : ""}${r.reportsTo ? ` | Reports to: ${r.reportsTo}` : ""}`;
      }).filter((x): x is string => x !== null);
      return ok(`${lines.length} agent(s) on project ${projectId}:\n\n${lines.join("\n")}`);
    }

    const hired = store.listHired();
    if (hired.length === 0) return ok("No agents currently rostered. Hire an agent into a project via the Agents page.");
    const lines = hired.map((a) => `${a.icon || "•"} ${a.name} (${a.role})`);
    return ok(`${hired.length} agent(s) rostered across all projects:\n\n${lines.join("\n")}\n\nPass projectId to see per-project heartbeat / reportsTo.`);
  },
};
