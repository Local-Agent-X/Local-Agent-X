/**
 * Issue Tools — lets agents create, update, and manage issues autonomously.
 *
 * Agents can:
 * - Create tasks and assign them to other agents
 * - Request approval from the user (shows in inbox)
 * - Comment on issues
 * - Update issue status
 * - List their own assigned tasks
 */

import type { ToolDefinition, ToolResult } from "./types.js";
import { IssueStore, AgentTemplateStore, ProjectStore, type IssueStatus, type IssuePriority } from "./agent-store.js";
import { ProjectRosterStore } from "./project-rosters.js";

/** Return the roster entry for an (agent, issue) pair when the issue is
 *  scoped to a project. reportsTo / heartbeat live on the roster, not
 *  the template, so consumers that care about hierarchy must read
 *  through this. */
function rosterForIssue(agentId: string, projectId?: string) {
  if (!projectId) return undefined;
  return ProjectRosterStore.getInstance().get(projectId, agentId);
}

/** Check if an agent can access an issue (same project or no project scoping) */
function canAccessIssue(agentId: string, issue: { projectId?: string }): boolean {
  if (!issue.projectId) return true; // Unscoped issues are accessible to all
  const projectStore = ProjectStore.getInstance();
  const agentProject = projectStore.getAgentProject(agentId);
  if (!agentProject) return true; // Unscoped agent can access everything
  return agentProject.id === issue.projectId;
}

/** Get the project ID for an agent (if scoped) */
function getAgentProjectId(agentId: string): string | undefined {
  const projectStore = ProjectStore.getInstance();
  const project = projectStore.getAgentProject(agentId);
  return project?.id;
}

function ok(content: string): ToolResult { return { content }; }
function err(content: string): ToolResult { return { content, isError: true }; }

const issueCreate: ToolDefinition = {
  name: "issue_create",
  description:
    "Create a new issue/task. Assign it to yourself or another agent. " +
    "Use this to break work into trackable tasks or delegate to other agents.",
  parameters: {
    type: "object",
    properties: {
      title: { type: "string", description: "Short title for the task" },
      description: { type: "string", description: "Detailed description of what needs to be done" },
      assignee: { type: "string", description: "Agent template ID to assign to (e.g. 'builtin-coder'). Leave empty for unassigned." },
      priority: { type: "string", enum: ["low", "medium", "high", "urgent"], description: "Priority level (default: medium)" },
      project: { type: "string", description: "Optional project name to group this under" },
      blockedBy: { type: "array", items: { type: "string" }, description: "Issue IDs this task is blocked by (e.g. ['LAX-1', 'LAX-2'])" },
    },
    required: ["title"],
  },
  async execute(args) {
    const store = IssueStore.getInstance();
    // Auto-scope to the assigning agent's project if not specified
    const assignee = String(args.assignee || "");
    const projectId = args.project ? String(args.project) : (assignee ? getAgentProjectId(assignee) : undefined);
    // Cross-project assignment is not allowed. The acting agent must be
    // in the same project as the target; if they need work done in another
    // project, surface that as a blocker so the parent (CEO / user) can
    // route it appropriately.
    if (assignee && projectId) {
      const targetProject = getAgentProjectId(assignee);
      if (targetProject && targetProject !== projectId) {
        return err(`Cannot assign to ${assignee}: agent is in a different project. Surface this as a blocker in your run report so the parent can route it.`);
      }
    }
    const issue = store.create({
      title: String(args.title || ""),
      description: String(args.description || ""),
      assignee,
      status: "open",
      priority: (args.priority as IssuePriority) || "medium",
      project: args.project ? String(args.project) : undefined,
      projectId,
      blockedBy: Array.isArray(args.blockedBy) ? args.blockedBy.map(String) : undefined,
      createdBy: "agent",
    });
    return ok(`Created ${issue.id}: "${issue.title}"${issue.assignee ? ` assigned to ${issue.assignee}` : ""}${projectId ? ` [project: ${projectId}]` : ""}`);
  },
};

const issueList: ToolDefinition = {
  name: "issue_list",
  description: "List issues/tasks. Filter by assignee, status, or project. Use this to check what work is pending.",
  parameters: {
    type: "object",
    properties: {
      assignee: { type: "string", description: "Filter by agent ID" },
      status: { type: "string", enum: ["open", "in-progress", "blocked", "done", "cancelled"], description: "Filter by status" },
      project: { type: "string", description: "Filter by project name" },
    },
  },
  async execute(args) {
    const store = IssueStore.getInstance();
    let issues = store.list({
      assignee: args.assignee ? String(args.assignee) : undefined,
      status: args.status as IssueStatus | undefined,
      project: args.project ? String(args.project) : undefined,
    });
    // Project scoping: if requesting agent is in a project, only show that project's issues
    if (args.assignee) {
      issues = issues.filter(i => canAccessIssue(String(args.assignee), i));
    }
    if (issues.length === 0) return ok("No issues found matching the filter.");
    const lines = issues.map(i =>
      `${i.id} [${i.status}] ${i.priority.toUpperCase()} — ${i.title}${i.assignee ? ` (${i.assignee})` : ""}`
    );
    return ok(`${issues.length} issue(s):\n\n${lines.join("\n")}`);
  },
};

const issueUpdate: ToolDefinition = {
  name: "issue_update",
  description: "Update an issue's status, add a comment, or reassign it. Use this to report progress on your tasks.",
  parameters: {
    type: "object",
    properties: {
      id: { type: "string", description: "Issue ID (e.g. 'LAX-1')" },
      status: { type: "string", enum: ["open", "in-progress", "blocked", "done", "cancelled"], description: "New status" },
      comment: { type: "string", description: "Add a comment explaining progress, blockers, or results" },
      assignee: { type: "string", description: "Reassign to a different agent" },
    },
    required: ["id"],
  },
  async execute(args) {
    const store = IssueStore.getInstance();
    const templateStore = AgentTemplateStore.getInstance();
    const id = String(args.id || "");
    const issue = store.get(id);
    if (!issue) return err(`Issue ${id} not found`);

    const updates: string[] = [];
    const prevStatus = issue.status;

    if (args.status) {
      store.update(id, { status: args.status as IssueStatus });
      updates.push(`status → ${args.status}`);
    }
    if (args.assignee) {
      store.update(id, { assignee: String(args.assignee) });
      updates.push(`assigned to ${args.assignee}`);
    }
    if (args.comment) {
      store.comment(id, "agent", String(args.comment));
      updates.push(`comment added`);
    }

    // HIERARCHY: auto-notify manager when status changes to done or blocked.
    // Hierarchy is project-scoped post-L3, so resolve reportsTo via the
    // roster entry for (issue.projectId, assignee), not the template.
    const newStatus = String(args.status || prevStatus);
    if (args.status && (newStatus === "done" || newStatus === "blocked") && issue.assignee) {
      const roster = rosterForIssue(issue.assignee, issue.projectId);
      if (roster?.reportsTo) {
        const manager = templateStore.get(roster.reportsTo);
        const managerRostered = manager
          ? ProjectRosterStore.getInstance().listByAgent(manager.id).length > 0
          : false;
        if (manager && managerRostered) {
          const statusMsg = newStatus === "done"
            ? `Task completed: ${issue.title}`
            : `Task blocked: ${issue.title} — needs help`;
          store.comment(id, "system", `Auto-notified manager ${manager.name}: ${statusMsg}`);
          updates.push(`manager ${manager.name} notified`);
        }
      }
    }

    return ok(`Updated ${id}: ${updates.join(", ") || "no changes"}`);
  },
};

const agentList: ToolDefinition = {
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

// ── Task Checkout/Release (locking) ──

const issueCheckout: ToolDefinition = {
  name: "issue_checkout",
  description:
    "Lock an issue so only you can work on it. Prevents other agents from picking it up. " +
    "Automatically sets status to in-progress. Returns null if already locked by another agent.",
  parameters: {
    type: "object",
    properties: {
      id: { type: "string", description: "Issue ID (e.g. 'LAX-1')" },
      agentId: { type: "string", description: "Your agent template ID" },
    },
    required: ["id", "agentId"],
  },
  async execute(args) {
    const store = IssueStore.getInstance();
    const result = store.checkout(String(args.id), String(args.agentId));
    if (!result) return err(`Cannot checkout ${args.id} — either not found or locked by another agent`);
    return ok(`Checked out ${result.id}: "${result.title}" — locked to ${args.agentId}`);
  },
};

const issueRelease: ToolDefinition = {
  name: "issue_release",
  description: "Release your lock on an issue so other agents can pick it up.",
  parameters: {
    type: "object",
    properties: {
      id: { type: "string", description: "Issue ID" },
      agentId: { type: "string", description: "Your agent template ID" },
    },
    required: ["id", "agentId"],
  },
  async execute(args) {
    const store = IssueStore.getInstance();
    return store.release(String(args.id), String(args.agentId))
      ? ok(`Released lock on ${args.id}`)
      : err(`Cannot release ${args.id} — not found or not locked by you`);
  },
};

// ── Issue Search ──

const issueSearch: ToolDefinition = {
  name: "issue_search",
  description: "Search issues by keyword. Searches titles, descriptions, and comments.",
  parameters: {
    type: "object",
    properties: {
      query: { type: "string", description: "Search query" },
    },
    required: ["query"],
  },
  async execute(args) {
    const store = IssueStore.getInstance();
    const results = store.search(String(args.query || ""));
    if (results.length === 0) return ok("No issues found matching that query.");
    const lines = results.map(i =>
      `${i.id} [${i.status}] ${i.priority} — ${i.title}${i.assignee ? ` (${i.assignee})` : ""}`
    );
    return ok(`${results.length} result(s):\n\n${lines.join("\n")}`);
  },
};

// ── Agent Self-Identity ──

const agentWhoAmI: ToolDefinition = {
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

    // Try to find the agent
    const agentId = String(args.agentId || "");
    const agent = agentId ? templateStore.get(agentId) : null;

    if (!agent) {
      // No specific identity — return general team context
      const hired = templateStore.listHired();
      const stats = issueStore.stats();
      return ok(
        `No specific agent identity provided.\n\n` +
        `Team: ${hired.length} hired agent(s)\n` +
        `Issues: ${stats.open} open, ${stats.inProgress} in progress, ${stats.blocked} blocked`
      );
    }

    // Get this agent's assigned issues
    const myIssues = issueStore.list({ assignee: agentId });
    const openIssues = myIssues.filter(i => i.status === "open" || i.status === "in-progress");
    const blockedIssues = myIssues.filter(i => i.status === "blocked");

    // Get recent comments on my issues (last 24h)
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
      // Collect direct reports project-by-project.
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

// ── Agent Wakeup (mention another agent) ──

const agentWakeup: ToolDefinition = {
  name: "agent_wakeup",
  description:
    "Wake up another hired agent by mentioning them in an issue comment. " +
    "This is how agents communicate — leave a comment on a shared issue and wake the other agent to read it. " +
    "The woken agent will check its issues and see your comment.",
  parameters: {
    type: "object",
    properties: {
      issueId: { type: "string", description: "Issue ID to comment on" },
      targetAgentId: { type: "string", description: "Agent template ID to wake up" },
      message: { type: "string", description: "Message to leave as a comment (the agent will read this)" },
    },
    required: ["issueId", "targetAgentId", "message"],
  },
  async execute(args) {
    const issueStore = IssueStore.getInstance();
    const templateStore = AgentTemplateStore.getInstance();
    const projectStore = ProjectStore.getInstance();
    const issueId = String(args.issueId || "");
    const targetId = String(args.targetAgentId || "");
    const message = String(args.message || "");

    const issue = issueStore.get(issueId);
    if (!issue) return err(`Issue ${issueId} not found`);

    const target = templateStore.get(targetId);
    if (!target) return err(`Agent ${targetId} not found`);
    if (ProjectRosterStore.getInstance().listByAgent(targetId).length === 0) {
      return err(`Agent ${targetId} is not on any project's roster — hire them into a project first`);
    }

    // Cross-project messaging is not allowed. Acting agent must be in
    // the same project as the target.
    if (issue.projectId) {
      const targetProject = projectStore.getAgentProject(targetId);
      if (targetProject && targetProject.id !== issue.projectId) {
        return err(`Cannot wake ${target.name}: agent is in project "${targetProject.name}", a different project from this issue. Surface this as a blocker so the parent can route it.`);
      }
    }

    // Leave the comment with @-mention
    issueStore.comment(issueId, "agent", `@${target.name}: ${message}`);

    // Wake the target through the canonical invoke layer. Same runtime
    // path agent_spawn uses — single entry-point for spawning, single
    // source of truth for the agent definition. Scope to the issue's
    // project so the spawned run has the right tool gating.
    const wakeupTask = `You were woken up by a message on issue ${issueId}.\n\n` +
      `Message: "${message}"\n\n` +
      `First call agent_whoami with agentId="${targetId}" to see your full context, then check issue ${issueId} and respond appropriately.`;

    const { invokeAgent } = await import("./agents/invoke.js");
    try {
      invokeAgent(targetId, wakeupTask, {
        scope: issue.projectId ? { projectId: issue.projectId } : undefined,
      });
    } catch (e) {
      return err(`Failed to wake ${target.name}: ${(e as Error).message}`);
    }

    return ok(`Woke up ${target.name}. They will check issue ${issueId} and see your message.`);
  },
};

export const issueTools: ToolDefinition[] = [
  issueCreate,
  issueList,
  issueUpdate,
  issueCheckout,
  issueRelease,
  issueSearch,
  agentList,
  agentWhoAmI,
  agentWakeup,
];
