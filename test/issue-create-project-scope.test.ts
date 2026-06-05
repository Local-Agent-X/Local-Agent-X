/**
 * Locks the fix for the false "agent is in a different project" rejection
 * on issue_create.
 *
 * Root cause (observed in run trace field-agent-1-mq10l2n5): the CEO
 * called issue_create with `project: "Nutrishop McKinney"` (the human
 * readable NAME) and an `assignee` rostered to that very project. The
 * old code stuffed the raw name into `projectId`, then the cross-project
 * guard compared that name against the assignee's canonical project id
 * (`proj-...`). A name never equals a `proj-...` id, so same-project
 * assignments were rejected with:
 *
 *   "Cannot assign to <id>: agent is in a different project. ..."
 *
 * resolveProjectId now maps a name → canonical id before the guard runs.
 *
 * These tests drive the live singletons in-process (creating disposable
 * fixtures and cleaning them up) because IssueStore/ProjectStore are
 * file-backed singletons without test-reset hooks, and the task scope
 * forbids touching them.
 */

import { describe, it, expect, afterEach } from "vitest";
import { ProjectStore, IssueStore } from "../src/agent-store/index.js";
import { ProjectRosterStore } from "../src/project-rosters.js";
import { resolveProjectId } from "../src/tools/issue-tools/shared.js";
import { issueCreateTool } from "../src/tools/issue-tools/issue-create.js";

const created: { projectIds: string[]; issueIds: string[]; rosters: Array<[string, string]> } = {
  projectIds: [],
  issueIds: [],
  rosters: [],
};

function uniqueName(prefix: string) {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

/** Create a disposable project with one rostered agent. Returns the
 *  project (with canonical id) and the agent's template id. */
function makeProjectWithAgent(name: string) {
  const projectStore = ProjectStore.getInstance();
  const project = projectStore.create({ name, description: "test fixture", agentIds: [] });
  created.projectIds.push(project.id);
  const agentId = uniqueName("tpl-test");
  ProjectRosterStore.getInstance().upsert(project.id, agentId);
  created.rosters.push([project.id, agentId]);
  return { project, agentId };
}

afterEach(() => {
  const projectStore = ProjectStore.getInstance();
  const issueStore = IssueStore.getInstance();
  const rosterStore = ProjectRosterStore.getInstance();
  for (const id of created.issueIds) issueStore.delete?.(id);
  for (const [pid, aid] of created.rosters) rosterStore.remove(pid, aid);
  for (const id of created.projectIds) projectStore.delete(id);
  created.projectIds = [];
  created.issueIds = [];
  created.rosters = [];
});

describe("resolveProjectId", () => {
  it("maps a project NAME to its canonical id", () => {
    const { project } = makeProjectWithAgent(uniqueName("Resolve By Name"));
    expect(resolveProjectId(project.name)).toBe(project.id);
  });

  it("passes a canonical project id through unchanged", () => {
    const { project } = makeProjectWithAgent(uniqueName("Resolve By Id"));
    expect(resolveProjectId(project.id)).toBe(project.id);
  });

  it("is case-insensitive / whitespace-trimmed on the name", () => {
    const { project } = makeProjectWithAgent(uniqueName("CaseTest"));
    expect(resolveProjectId(`  ${project.name.toUpperCase()}  `)).toBe(project.id);
  });

  it("falls back to the assignee's project when name is unknown", () => {
    const { project, agentId } = makeProjectWithAgent(uniqueName("Fallback"));
    expect(resolveProjectId("does-not-exist-anywhere", agentId)).toBe(project.id);
  });
});

describe("issue_create cross-project guard", () => {
  it("does NOT reject same-project assignment when project is given by NAME", async () => {
    const { project, agentId } = makeProjectWithAgent(uniqueName("Nutrishop"));

    const result = await issueCreateTool.execute({
      title: "Develop Marketing Strategy",
      assignee: agentId,
      project: project.name, // human-readable name, the exact failing shape
    });

    expect(result.isError).toBeFalsy();
    expect(result.content).toMatch(/^Created /);
    expect(result.content).toContain(agentId);

    const m = result.content.match(/Created (\S+):/);
    if (m) created.issueIds.push(m[1]);

    // and it is scoped to the canonical id, not the raw name
    const created2 = IssueStore.getInstance().list().find((i) => i.assignee === agentId && i.title === "Develop Marketing Strategy");
    expect(created2?.projectId).toBe(project.id);
  });

  it("still rejects a genuinely cross-project assignment", async () => {
    const home = makeProjectWithAgent(uniqueName("HomeProj"));
    const other = makeProjectWithAgent(uniqueName("OtherProj"));

    // Assigning another project's agent while scoping to HomeProj must fail.
    const result = await issueCreateTool.execute({
      title: "Cross-project task",
      assignee: other.agentId,
      project: home.project.name,
    });

    expect(result.isError).toBe(true);
    expect(result.content).toContain("different project");
  });
});
