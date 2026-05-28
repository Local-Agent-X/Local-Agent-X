/**
 * Shared helpers for the issue-tools modules — ToolResult shorthand and
 * project-scope resolvers used across every issue/agent tool.
 */

import type { ToolResult } from "../../types.js";
import { ProjectStore } from "../../agent-store/index.js";
import { ProjectRosterStore } from "../../project-rosters.js";

export function ok(content: string): ToolResult { return { content }; }
export function err(content: string): ToolResult { return { content, isError: true }; }

/** Return the roster entry for an (agent, issue) pair when the issue is
 *  scoped to a project. reportsTo / heartbeat live on the roster, not
 *  the template, so consumers that care about hierarchy must read
 *  through this. */
export function rosterForIssue(agentId: string, projectId?: string) {
  if (!projectId) return undefined;
  return ProjectRosterStore.getInstance().get(projectId, agentId);
}

/** Check if an agent can access an issue (same project or no project scoping) */
export function canAccessIssue(agentId: string, issue: { projectId?: string }): boolean {
  if (!issue.projectId) return true;
  const projectStore = ProjectStore.getInstance();
  const agentProject = projectStore.getAgentProject(agentId);
  if (!agentProject) return true;
  return agentProject.id === issue.projectId;
}

/** Get the project ID for an agent (if scoped) */
export function getAgentProjectId(agentId: string): string | undefined {
  const projectStore = ProjectStore.getInstance();
  const project = projectStore.getAgentProject(agentId);
  return project?.id;
}
