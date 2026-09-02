// Spawn lineage for agent-to-agent wakes (F5).
//
// agent_wakeup and issue_update's blocked→manager wake spawn other agents
// through the canonical invoke door but used to carry NO parent linkage at
// all — the woken run rendered as a parentless root in the AGENTS panel
// and its AgentRun row had no lineage. The trusted `_sessionId` the tool
// executor stamps (`agent-<runId>` for a sub-agent caller) names the
// calling run; it must ride the spawn as parentAgentId. A chat-session
// caller has no run — the woken agent stays a root, unchanged.
//
// Fixtures mirror escalate-tool.test.ts: real disk-backed stores with
// uniquely-named projects/templates, driver stubbed via
// registerAgentRunDriver.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  AgentTemplateStore,
  ProjectStore,
  IssueStore,
  type Project,
  type Issue,
  type AgentTemplate,
} from "../../agent-store/index.js";
import { ProjectRosterStore } from "../../project-rosters.js";
import { Handler } from "../../agency/handler.js";
import { AgentCatalog } from "../../agents/catalog.js";
import {
  registerAgentRunDriver,
  _resetAgentRunDriverForTest,
  type AgentRunDriverRequest,
} from "../../agents/runtime.js";
import { agentWakeupTool } from "./agent-wakeup.js";
import { issueUpdateTool } from "./issue-update.js";

let project: Project;
let managerTpl: AgentTemplate;
let workerTpl: AgentTemplate;
let createdIssues: Issue[] = [];

const driverCalls: AgentRunDriverRequest[] = [];

beforeEach(() => {
  driverCalls.length = 0;
  ProjectRosterStore._resetForTest();

  const templates = AgentTemplateStore.getInstance();
  const projects = ProjectStore.getInstance();

  managerTpl = templates.create({
    name: `WakeMgr-${Math.random().toString(36).slice(2, 8)}`,
    role: "manager",
    description: "test manager",
    systemPrompt: "you are a test manager",
    allowedTools: ["agent_wakeup"],
  });
  workerTpl = templates.create({
    name: `WakeWrk-${Math.random().toString(36).slice(2, 8)}`,
    role: "worker",
    description: "test worker",
    systemPrompt: "you are a test worker",
    allowedTools: ["agent_wakeup"],
  });

  project = projects.create({
    name: `wakeup-test-${Math.random().toString(36).slice(2, 8)}`,
    description: "",
    agentIds: [managerTpl.id, workerTpl.id],
  });

  const rosters = ProjectRosterStore.getInstance();
  rosters.upsert(project.id, managerTpl.id);
  rosters.upsert(project.id, workerTpl.id, { reportsTo: managerTpl.id });

  registerAgentRunDriver(async (req) => {
    driverCalls.push(req);
    return { result: "stub-ok", success: true, tokens: 0 };
  });
});

afterEach(() => {
  _resetAgentRunDriverForTest();

  const issues = IssueStore.getInstance();
  for (const i of createdIssues) issues.delete(i.id);
  createdIssues = [];

  const rosters = ProjectRosterStore.getInstance();
  rosters.remove(project.id, managerTpl.id);
  rosters.remove(project.id, workerTpl.id);

  const templates = AgentTemplateStore.getInstance();
  templates.delete(managerTpl.id);
  templates.delete(workerTpl.id);
  ProjectStore.getInstance().delete(project.id);

  ProjectRosterStore._resetForTest();
  AgentCatalog._resetForTest();
});

/** Attach a FieldAgent caller and return the tool-session id the executor
 *  would stamp, plus the run id lineage should carry. */
function attachCaller(templateId: string): { sessionId: string; runId: string } {
  const { agentId } = Handler.getInstance().attachExternalRun({
    name: "caller",
    role: "caller",
    task: "test",
    templateId,
  });
  return { sessionId: `agent-${agentId}`, runId: agentId };
}

function makeIssue(assignee: string = workerTpl.id): Issue {
  const issue = IssueStore.getInstance().create({
    title: "wake test",
    description: "test",
    assignee,
    status: "in-progress",
    priority: "medium",
    projectId: project.id,
    createdBy: "test",
  });
  createdIssues.push(issue);
  return issue;
}

describe("agent_wakeup spawn lineage", () => {
  it("threads the calling RUN's id as parentAgentId (no parentSessionId — nothing to inject into chat)", async () => {
    const issue = makeIssue();
    const caller = attachCaller(workerTpl.id);

    const result = await agentWakeupTool.execute({
      issueId: issue.id,
      targetAgentId: managerTpl.id,
      message: "please review my blocker",
      _sessionId: caller.sessionId,
    });

    expect(result.isError).toBeFalsy();
    expect(driverCalls).toHaveLength(1);
    expect(driverCalls[0].templateId).toBe(managerTpl.id);
    expect(driverCalls[0].parentAgentId).toBe(caller.runId);
    expect(driverCalls[0].parentSessionId).toBeUndefined();
  });

  it("a chat-session caller wakes with NO spawn parent (woken agent renders as a root)", async () => {
    const issue = makeIssue();

    const result = await agentWakeupTool.execute({
      issueId: issue.id,
      targetAgentId: managerTpl.id,
      message: "user says check this",
      _sessionId: "chat-session-xyz",
    });

    expect(result.isError).toBeFalsy();
    expect(driverCalls).toHaveLength(1);
    expect(driverCalls[0].parentAgentId).toBeUndefined();
  });
});

describe("issue_update blocked→manager wake lineage", () => {
  it("the manager's out-of-cycle wake nests under the run that flipped the issue to blocked", async () => {
    const issue = makeIssue(workerTpl.id);
    const caller = attachCaller(workerTpl.id);

    const result = await issueUpdateTool.execute({
      id: issue.id,
      status: "blocked",
      _sessionId: caller.sessionId,
    });

    expect(result.isError).toBeFalsy();
    expect(String(result.content)).toContain("woken");
    expect(driverCalls).toHaveLength(1);
    expect(driverCalls[0].templateId).toBe(managerTpl.id);
    expect(driverCalls[0].parentAgentId).toBe(caller.runId);
    expect(driverCalls[0].parentSessionId).toBeUndefined();
  });
});
