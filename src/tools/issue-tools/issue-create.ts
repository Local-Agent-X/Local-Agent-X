import type { ToolDefinition } from "../../types.js";
import { IssueStore, type IssuePriority } from "../../agent-store/index.js";
import { ok, err, getAgentProjectId, resolveProjectId } from "./shared.js";

export const issueCreateTool: ToolDefinition = {
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
    const assignee = String(args.assignee || "");
    // Resolve the (possibly human-readable) project name to a canonical
    // project id before scoping/guarding — see resolveProjectId. Passing
    // the raw name through used to make the cross-project guard below
    // compare a name against a `proj-...` id and falsely reject same-
    // project assignments.
    const projectId = resolveProjectId(args.project ? String(args.project) : undefined, assignee);
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
