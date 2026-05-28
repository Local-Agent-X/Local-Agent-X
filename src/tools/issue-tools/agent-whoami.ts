import type { ToolDefinition } from "../../types.js";
import { IssueStore, AgentTemplateStore } from "../../agent-store/index.js";
import { ProjectRosterStore } from "../../project-rosters.js";
import { ok } from "./shared.js";

export const agentWhoAmITool: ToolDefinition = {
  name: "agent_whoami",
  description:
    "Get your own identity, role, assigned issues, and team context. " +
    "Use this when you wake up or start a task to understand who you are and what you should be working on.",
  parameters: {
    type: "object",
    properties: {
      agentId: { type: "string", description: "Your agent template ID (if known)" },
    },
  },
  async execute(args) {
    const templateStore = AgentTemplateStore.getInstance();
    const issueStore = IssueStore.getInstance();

    const agentId = String(args.agentId || "");
    const agent = agentId ? templateStore.get(agentId) : null;

    if (!agent) {
      const hired = templateStore.listHired();
      const stats = issueStore.stats();
      return ok(
        `No specific agent identity provided.\n\n` +
        `Team: ${hired.length} hired agent(s)\n` +
        `Issues: ${stats.open} open, ${stats.inProgress} in progress, ${stats.blocked} blocked`
      );
    }

    const myIssues = issueStore.list({ assignee: agentId });
    const openIssues = myIssues.filter(i => i.status === "open" || i.status === "in-progress");
    const blockedIssues = myIssues.filter(i => i.status === "blocked");

    const recentComments: string[] = [];
    const dayAgo = Date.now() - 86400000;
    for (const issue of myIssues) {
      for (const c of issue.comments) {
        if (c.createdAt > dayAgo && c.author !== agentId) {
          recentComments.push(`${issue.id}: ${c.author} said: "${c.content.slice(0, 100)}"`);
        }
      }
    }

    // Manager / heartbeat info is project-scoped post-L3. Aggregate
    // across every project the agent is on so agent_whoami stays
    // useful even when the caller didn't pass a project context.
    const rosterStore = ProjectRosterStore.getInstance();
    const myRosters = rosterStore.listByAgent(agentId);
    const directReports: Array<{ id: string; role: string; icon?: string; name: string; projectId: string }> = [];
    const hierarchyLines: string[] = [];
    const heartbeatLines: string[] = [];
    for (const r of myRosters) {
      if (r.reportsTo) hierarchyLines.push(`  [${r.projectId}] Reports to: ${r.reportsTo}`);
      else hierarchyLines.push(`  [${r.projectId}] Reports to: Board (user)`);
      if (r.heartbeatEnabled) heartbeatLines.push(`  [${r.projectId}] ${r.heartbeatSchedule}`);
      const projectRosters = rosterStore.listByProject(r.projectId);
      for (const pr of projectRosters) {
        if (pr.reportsTo !== agentId) continue;
        const tpl = templateStore.get(pr.agentId);
        if (tpl) directReports.push({ id: tpl.id, role: tpl.role, icon: tpl.icon, name: tpl.name, projectId: r.projectId });
      }
    }
    const isManager = directReports.length > 0;

    const subordinateInfo: string[] = [];
    if (isManager) {
      for (const report of directReports) {
        const reportIssues = issueStore.list({ assignee: report.id });
        const active = reportIssues.filter(i => i.status === "in-progress").length;
        const blocked = reportIssues.filter(i => i.status === "blocked").length;
        const done = reportIssues.filter(i => i.status === "done").length;
        subordinateInfo.push(`  ${report.icon || "•"} ${report.name} (${report.role}) [${report.projectId}]: ${active} active, ${blocked} blocked, ${done} done`);
      }
    }

    const parts = [
      `You are: ${agent.icon || ""} ${agent.name} (${agent.role})`,
      myRosters.length === 0 ? `Not currently on any project's roster.` : `On ${myRosters.length} project(s):`,
      ...hierarchyLines,
      heartbeatLines.length > 0 ? `Heartbeat schedules:` : null,
      ...heartbeatLines,
      isManager ? `\nYou manage ${directReports.length} agent(s):` : null,
      ...subordinateInfo,
      `\nYour assigned issues (${openIssues.length} active):`,
      ...openIssues.map(i => `  ${i.id} [${i.status}] ${i.priority.toUpperCase()} — ${i.title}${i.lockedBy ? ` (locked by ${i.lockedBy})` : ""}`),
      blockedIssues.length > 0 ? `\nBlocked (${blockedIssues.length}):` : null,
      ...blockedIssues.map(i => `  ${i.id} — ${i.title}`),
      recentComments.length > 0 ? `\nRecent activity (last 24h):` : null,
      ...recentComments.slice(0, 10),
    ].filter(Boolean);

    return ok(parts.join("\n"));
  },
};
