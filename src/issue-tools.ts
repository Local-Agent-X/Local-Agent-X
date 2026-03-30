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
    "Set needsApproval=true to request user approval before proceeding (appears in their inbox). " +
    "Use this to break work into trackable tasks, delegate to other agents, or ask for permission.",
  parameters: {
    type: "object",
    properties: {
      title: { type: "string", description: "Short title for the task" },
      description: { type: "string", description: "Detailed description of what needs to be done" },
      assignee: { type: "string", description: "Agent template ID to assign to (e.g. 'builtin-coder'). Leave empty for unassigned." },
      priority: { type: "string", enum: ["low", "medium", "high", "urgent"], description: "Priority level (default: medium)" },
      needsApproval: { type: "boolean", description: "If true, this goes to the user's inbox for approval before work begins" },
      approvalType: { type: "string", description: "Type of approval: 'hire', 'action', 'spend', 'deploy', or custom label" },
      project: { type: "string", description: "Optional project name to group this under" },
      blockedBy: { type: "array", items: { type: "string" }, description: "Issue IDs this task is blocked by (e.g. ['SAX-1', 'SAX-2'])" },
    },
    required: ["title"],
  },
  async execute(args) {
    const store = IssueStore.getInstance();
    // Auto-scope to the assigning agent's project if not specified
    const assignee = String(args.assignee || "");
    const projectId = args.project ? String(args.project) : (assignee ? getAgentProjectId(assignee) : undefined);
    // Security: if assigning to another agent, verify same project
    if (assignee && projectId) {
      const targetProject = getAgentProjectId(assignee);
      if (targetProject && targetProject !== projectId) {
        return err(`Cannot assign to ${assignee} — they belong to a different project. Cross-project assignment requires user approval.`);
      }
    }
    const issue = store.create({
      title: String(args.title || ""),
      description: String(args.description || ""),
      assignee,
      status: "open",
      priority: (args.priority as IssuePriority) || "medium",
      needsApproval: !!args.needsApproval,
      approvalType: args.approvalType ? String(args.approvalType) : undefined,
      project: args.project ? String(args.project) : undefined,
      projectId,
      blockedBy: Array.isArray(args.blockedBy) ? args.blockedBy.map(String) : undefined,
      createdBy: "agent",
    });
    const approval = issue.needsApproval ? " (sent to user inbox for approval)" : "";
    return ok(`Created ${issue.id}: "${issue.title}"${issue.assignee ? ` assigned to ${issue.assignee}` : ""}${projectId ? ` [project: ${projectId}]` : ""}${approval}`);
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
      `${i.id} [${i.status}] ${i.priority.toUpperCase()} — ${i.title}${i.assignee ? ` (${i.assignee})` : ""}${i.needsApproval ? " ⏳ PENDING APPROVAL" : ""}`
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
      id: { type: "string", description: "Issue ID (e.g. 'SAX-1')" },
      status: { type: "string", enum: ["open", "in-progress", "blocked", "done", "cancelled"], description: "New status" },
      comment: { type: "string", description: "Add a comment explaining progress, blockers, or results" },
      assignee: { type: "string", description: "Reassign to a different agent" },
    },
    required: ["id"],
  },
  async execute(args) {
    const store = IssueStore.getInstance();
    const id = String(args.id || "");
    const issue = store.get(id);
    if (!issue) return err(`Issue ${id} not found`);

    const updates: string[] = [];

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

    return ok(`Updated ${id}: ${updates.join(", ") || "no changes"}`);
  },
};

const issueRequestApproval: ToolDefinition = {
  name: "issue_request_approval",
  description:
    "Request user approval for something. Creates an issue in the user's inbox that they must approve or reject. " +
    "Use this when you need permission for: hiring a new agent, making an expensive API call, deploying code, " +
    "or any action that should have human oversight.",
  parameters: {
    type: "object",
    properties: {
      title: { type: "string", description: "What you're requesting approval for" },
      description: { type: "string", description: "Explain why this is needed and what will happen if approved" },
      approvalType: { type: "string", description: "Category: 'hire', 'action', 'spend', 'deploy'" },
    },
    required: ["title", "description"],
  },
  async execute(args) {
    const store = IssueStore.getInstance();
    const issue = store.create({
      title: String(args.title || ""),
      description: String(args.description || ""),
      assignee: "",
      status: "open",
      priority: "high",
      needsApproval: true,
      approvalType: String(args.approvalType || "action"),
      createdBy: "agent",
    });
    return ok(`Approval request ${issue.id} sent to user inbox: "${issue.title}"\nWaiting for user to approve or reject.`);
  },
};

const agentList: ToolDefinition = {
  name: "agent_team_list",
  description: "List all hired agents on the team. Shows their roles, heartbeat status, and what they're working on.",
  parameters: { type: "object", properties: {} },
  async execute() {
    const store = AgentTemplateStore.getInstance();
    const hired = store.listHired();
    if (hired.length === 0) return ok("No agents currently hired. Use the Agents page to hire from templates.");
    const lines = hired.map(a =>
      `${a.icon || "•"} ${a.name} (${a.role}) — ${a.hired ? "Active" : "Inactive"}${a.heartbeatEnabled ? ` | Heartbeat: ${a.heartbeatSchedule}` : ""}${a.reportsTo ? ` | Reports to: ${a.reportsTo}` : ""}`
    );
    return ok(`${hired.length} agent(s) on the team:\n\n${lines.join("\n")}`);
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
      id: { type: "string", description: "Issue ID (e.g. 'SAX-1')" },
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
        `Issues: ${stats.open} open, ${stats.inProgress} in progress, ${stats.blocked} blocked, ${stats.pendingApproval} pending approval`
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

    const parts = [
      `You are: ${agent.icon || ""} ${agent.name} (${agent.role})`,
      agent.reportsTo ? `Reports to: ${agent.reportsTo}` : null,
      `Heartbeat: ${agent.heartbeatEnabled ? agent.heartbeatSchedule : "Off"}`,
      `\nAssigned issues (${openIssues.length} active):`,
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
    if (!target || !target.hired) return err(`Agent ${targetId} not found or not hired`);

    // SECURITY: Cross-project communication blocked
    if (issue.projectId) {
      const targetProject = projectStore.getAgentProject(targetId);
      if (targetProject && targetProject.id !== issue.projectId) {
        return err(`BLOCKED: Agent ${target.name} belongs to project "${targetProject.name}" but this issue is in a different project. Cross-project communication is not allowed. Use issue_request_approval to ask the user to relay the message.`);
      }
    }

    // Leave the comment with @-mention
    issueStore.comment(issueId, "agent", `@${target.name}: ${message}`);

    // If the issue isn't assigned to the target, note that
    const context = issue.assignee === targetId
      ? "They are assigned to this issue and will see the comment."
      : "Note: this issue is not assigned to them — consider reassigning if needed.";

    return ok(`Wakeup sent to ${target.name} on ${issueId}.\nComment posted: "@${target.name}: ${message}"\n${context}`);
  },
};

export const issueTools: ToolDefinition[] = [
  issueCreate,
  issueList,
  issueUpdate,
  issueRequestApproval,
  issueCheckout,
  issueRelease,
  issueSearch,
  agentList,
  agentWhoAmI,
  agentWakeup,
];
