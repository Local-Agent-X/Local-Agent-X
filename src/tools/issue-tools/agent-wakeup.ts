import type { ToolDefinition } from "../../types.js";
import { IssueStore, AgentTemplateStore, ProjectStore } from "../../agent-store.js";
import { ProjectRosterStore } from "../../project-rosters.js";
import { ok, err } from "./shared.js";

export const agentWakeupTool: ToolDefinition = {
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

    issueStore.comment(issueId, "agent", `@${target.name}: ${message}`);

    // Wake the target through the canonical invoke layer. Same runtime
    // path agent_spawn uses — single entry-point for spawning, single
    // source of truth for the agent definition. Scope to the issue's
    // project so the spawned run has the right tool gating.
    const wakeupTask = `You were woken up by a message on issue ${issueId}.\n\n` +
      `Message: "${message}"\n\n` +
      `First call agent_whoami with agentId="${targetId}" to see your full context, then check issue ${issueId} and respond appropriately.`;

    const { invokeAgent } = await import("../../agents/invoke.js");
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
