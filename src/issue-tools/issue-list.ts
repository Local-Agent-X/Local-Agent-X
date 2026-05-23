import type { ToolDefinition } from "../types.js";
import { IssueStore, type IssueStatus } from "../agent-store.js";
import { ok, canAccessIssue } from "./shared.js";

export const issueListTool: ToolDefinition = {
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
