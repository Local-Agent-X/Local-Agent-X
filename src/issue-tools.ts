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
import { IssueStore, AgentTemplateStore, type IssueStatus, type IssuePriority } from "./agent-store.js";

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
    const issue = store.create({
      title: String(args.title || ""),
      description: String(args.description || ""),
      assignee: String(args.assignee || ""),
      status: "open",
      priority: (args.priority as IssuePriority) || "medium",
      needsApproval: !!args.needsApproval,
      approvalType: args.approvalType ? String(args.approvalType) : undefined,
      project: args.project ? String(args.project) : undefined,
      blockedBy: Array.isArray(args.blockedBy) ? args.blockedBy.map(String) : undefined,
      createdBy: "agent",
    });
    const approval = issue.needsApproval ? " (sent to user inbox for approval)" : "";
    return ok(`Created ${issue.id}: "${issue.title}"${issue.assignee ? ` assigned to ${issue.assignee}` : ""}${approval}`);
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
    const issues = store.list({
      assignee: args.assignee ? String(args.assignee) : undefined,
      status: args.status as IssueStatus | undefined,
      project: args.project ? String(args.project) : undefined,
    });
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

export const issueTools: ToolDefinition[] = [
  issueCreate,
  issueList,
  issueUpdate,
  issueRequestApproval,
  agentList,
];
