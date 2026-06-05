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

/** Resolve a user-supplied `project` argument to a canonical project ID.
 *
 *  Agents (and the model driving them) refer to projects by their
 *  human-readable NAME — e.g. "Nutrishop McKinney" — not the internal
 *  `proj-...` id. Issue scoping (`projectId`) and the cross-project
 *  assignment guard both compare against the canonical id returned by
 *  ProjectStore, so a raw name leaks straight through as a bogus
 *  "projectId" that can never equal a real id. That produced false
 *  "agent is in a different project" rejections on issue_create.
 *
 *  Resolution order:
 *    1. exact project id match (already canonical) → use as-is
 *    2. case-insensitive name match → that project's id
 *    3. no match → fall back to the assignee's own project (so the
 *       issue still scopes correctly), else undefined.
 */
export function resolveProjectId(
  project: string | undefined,
  assignee?: string,
): string | undefined {
  const raw = project?.trim();
  if (raw) {
    const store = ProjectStore.getInstance();
    if (store.get(raw)) return raw;          // already a canonical id
    const byName = store.findByName(raw);
    if (byName) return byName.id;            // name → id
  }
  return assignee ? getAgentProjectId(assignee) : undefined;
}
