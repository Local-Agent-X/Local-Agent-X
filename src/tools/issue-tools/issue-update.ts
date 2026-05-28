import type { ToolDefinition } from "../../types.js";
import { IssueStore, AgentTemplateStore, type IssueStatus } from "../../agent-store/index.js";
import { ProjectRosterStore } from "../../project-rosters.js";
import { ok, err, rosterForIssue } from "./shared.js";

export const issueUpdateTool: ToolDefinition = {
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
    //
    // done   → leave a comment; manager picks it up on next heartbeat.
    // blocked → invoke the manager out-of-cycle via canonical invoke
    //           (implicit escalation — the chunk-2 wake-trigger spec).
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

          if (newStatus === "blocked") {
            try {
              const { invokeAgent } = await import("../../agents/invoke.js");
              const task =
                `Your report's issue ${id} just went BLOCKED: "${issue.title}".\n\n` +
                `Read issue ${id} (use issue_list / issue_search), triage the blocker, ` +
                `and either unblock the report (agent_wakeup) or escalate further ` +
                `(agent_escalate to your manager / user) if it needs a decision you can't make.`;
              invokeAgent(manager.id, task, {
                scope: issue.projectId ? { projectId: issue.projectId } : undefined,
              });
              updates.push(`manager ${manager.name} woken`);
            } catch (e) {
              store.comment(id, "system", `Failed to wake manager ${manager.name}: ${(e as Error).message}`);
            }
          }
        }
      }
    }

    return ok(`Updated ${id}: ${updates.join(", ") || "no changes"}`);
  },
};
