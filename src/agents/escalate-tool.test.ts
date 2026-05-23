import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  AgentCatalog,
} from "./catalog.js";
import {
  AgentTemplateStore,
  ProjectStore,
  IssueStore,
  type Project,
  type Issue,
  type AgentTemplate,
} from "../agent-store.js";
import { ProjectRosterStore } from "../project-rosters.js";
import { Handler } from "../agency/handler.js";
import { EventBus } from "../event-bus.js";
import {
  registerAgentRunDriver,
  _resetAgentRunDriverForTest,
  type AgentRunDriverRequest,
} from "./runtime.js";
import { agentEscalate } from "./escalate-tool.js";

// ── Fixtures ──────────────────────────────────────────────────────────
// Stores are real disk-backed singletons. Tests create uniquely-named
// projects + templates so concurrent or repeated runs don't collide.

let project: Project;
let altProject: Project;
let managerTpl: AgentTemplate;
let workerTpl: AgentTemplate;
let outsiderTpl: AgentTemplate;
let createdIssues: Issue[] = [];

const driverCalls: AgentRunDriverRequest[] = [];
const escalationEvents: Array<Record<string, unknown>> = [];
let escalationListener: ((d: unknown) => void) | null = null;

beforeEach(() => {
  driverCalls.length = 0;
  escalationEvents.length = 0;
  ProjectRosterStore._resetForTest();

  const templates = AgentTemplateStore.getInstance();
  const projects = ProjectStore.getInstance();

  managerTpl = templates.create({
    name: `TestMgr-${Math.random().toString(36).slice(2, 8)}`,
    role: "manager",
    description: "test manager",
    systemPrompt: "you are a test manager",
    allowedTools: ["agent_escalate"],
  });
  workerTpl = templates.create({
    name: `TestWrk-${Math.random().toString(36).slice(2, 8)}`,
    role: "worker",
    description: "test worker",
    systemPrompt: "you are a test worker",
    allowedTools: ["agent_escalate"],
  });
  outsiderTpl = templates.create({
    name: `TestOut-${Math.random().toString(36).slice(2, 8)}`,
    role: "worker",
    description: "outsider",
    systemPrompt: "outsider",
    allowedTools: ["agent_escalate"],
  });

  project = projects.create({
    name: `escalate-test-${Math.random().toString(36).slice(2, 8)}`,
    description: "",
    agentIds: [managerTpl.id, workerTpl.id],
  });
  altProject = projects.create({
    name: `escalate-test-alt-${Math.random().toString(36).slice(2, 8)}`,
    description: "",
    agentIds: [outsiderTpl.id],
  });

  const rosters = ProjectRosterStore.getInstance();
  rosters.upsert(project.id, managerTpl.id);
  rosters.upsert(project.id, workerTpl.id, { reportsTo: managerTpl.id });
  rosters.upsert(altProject.id, outsiderTpl.id);

  escalationListener = (d: unknown) => { escalationEvents.push(d as Record<string, unknown>); };
  EventBus.on("handler:agent-escalation", escalationListener);

  registerAgentRunDriver(async (req) => {
    driverCalls.push(req);
    return { result: "stub-ok", success: true, tokens: 0 };
  });
});

afterEach(() => {
  if (escalationListener) {
    EventBus.off("handler:agent-escalation", escalationListener);
    escalationListener = null;
  }
  _resetAgentRunDriverForTest();

  // Tear down disk fixtures.
  const issues = IssueStore.getInstance();
  for (const i of createdIssues) issues.delete(i.id);
  createdIssues = [];

  const templates = AgentTemplateStore.getInstance();
  templates.delete(managerTpl.id);
  templates.delete(workerTpl.id);
  templates.delete(outsiderTpl.id);

  // Roster entries persist on upsert; _resetForTest() only clears the
  // in-memory singleton, so without explicit removes ~/.lax/project-
  // rosters.json accumulates orphan entries from every test run.
  // Remove every entry created in beforeEach before the singleton reset.
  const rosters = ProjectRosterStore.getInstance();
  rosters.remove(project.id, managerTpl.id);
  rosters.remove(project.id, workerTpl.id);
  rosters.remove(altProject.id, outsiderTpl.id);
  const projects = ProjectStore.getInstance();
  projects.delete(project.id);
  projects.delete(altProject.id);

  ProjectRosterStore._resetForTest();
  AgentCatalog._resetForTest();
});

/** Attach a FieldAgent for `templateId` and return the synthetic sessionId
 *  the tool executor would have stamped. */
function attachCaller(templateId: string): string {
  const { agentId } = Handler.getInstance().attachExternalRun({
    name: "caller",
    role: "caller",
    task: "test",
    templateId,
  });
  return `agent-${agentId}`;
}

// ── Catalog presence ──────────────────────────────────────────────────

describe("Manager template", () => {
  it("appears in AgentCatalog.list() and is rosterable", () => {
    const defs = AgentCatalog.getInstance().list();
    const mgr = defs.find((d) => d.id === "builtin-manager");
    expect(mgr).toBeDefined();
    expect(mgr!.role).toBe("manager");
    expect(mgr!.allowedTools).toContain("agent_escalate");
    expect(mgr!.defaultModel?.provider).toBe("anthropic");
    expect(mgr!.defaultModel?.model).toBe("claude-opus-4-7");
  });
});

// ── Resolution: to: "manager" ────────────────────────────────────────

describe("agent_escalate to:'manager'", () => {
  it("wakes the manager when caller has reportsTo set (urgency:'high')", async () => {
    const sessionId = attachCaller(workerTpl.id);
    const result = await agentEscalate.execute({
      to: "manager",
      context: "stuck on the third sub-task; need a decision on scope",
      urgency: "high",
      _sessionId: sessionId,
    });

    expect(result.isError).toBeFalsy();
    expect(result.content).toContain(managerTpl.name);
    expect(driverCalls).toHaveLength(1);
    expect(driverCalls[0].templateId).toBe(managerTpl.id);
    expect(driverCalls[0].task).toContain("escalated to by");
  });

  it("auto-promotes to user when caller has no reportsTo (top of chain)", async () => {
    const sessionId = attachCaller(managerTpl.id); // manager has no reportsTo
    const result = await agentEscalate.execute({
      to: "manager",
      context: "I need a budget approval",
      urgency: "high",
      _sessionId: sessionId,
    });

    expect(result.isError).toBeFalsy();
    expect(result.content).toContain("user");
    expect(driverCalls).toHaveLength(0);
    expect(escalationEvents).toHaveLength(1);
    expect(escalationEvents[0].to).toBe("user");
    expect(escalationEvents[0].urgency).toBe("high");
  });

  it("rejects when caller is the human chat user (no roster)", async () => {
    const result = await agentEscalate.execute({
      to: "manager",
      context: "from chat",
      urgency: "high",
      _sessionId: "chat-session-xyz",
    });
    expect(result.isError).toBe(true);
    expect(result.content).toMatch(/sub-agent caller/i);
  });
});

// ── Resolution: to: "user" ───────────────────────────────────────────

describe("agent_escalate to:'user'", () => {
  it("emits handler:agent-escalation with wake hint when urgency is high", async () => {
    const sessionId = attachCaller(workerTpl.id);
    const result = await agentEscalate.execute({
      to: "user",
      context: "need API key for stripe to continue",
      urgency: "high",
      _sessionId: sessionId,
    });
    expect(result.isError).toBeFalsy();
    expect(escalationEvents).toHaveLength(1);
    expect(escalationEvents[0].to).toBe("user");
    expect(escalationEvents[0].urgency).toBe("high");
    expect(escalationEvents[0].from).toBe(workerTpl.id);
  });
});

// ── Resolution: to: <agentId> ────────────────────────────────────────

describe("agent_escalate to:<agentId>", () => {
  it("rejects cross-project escalation", async () => {
    const sessionId = attachCaller(workerTpl.id);
    const result = await agentEscalate.execute({
      to: outsiderTpl.id,
      context: "ping",
      urgency: "high",
      _sessionId: sessionId,
    });
    expect(result.isError).toBe(true);
    expect(result.content).toMatch(/different project/i);
    expect(driverCalls).toHaveLength(0);
  });

  it("urgency:'normal' leaves a record, no wake call", async () => {
    const sessionId = attachCaller(workerTpl.id);
    const result = await agentEscalate.execute({
      to: managerTpl.id,
      context: "FYI when you get a chance",
      urgency: "normal",
      _sessionId: sessionId,
    });
    expect(result.isError).toBeFalsy();
    expect(driverCalls).toHaveLength(0);
    expect(escalationEvents).toHaveLength(1);
    expect(escalationEvents[0].urgency).toBe("normal");
    expect(escalationEvents[0].to).toBe(managerTpl.id);
  });

  it("urgency:'high' invokes the target agent through the canonical path", async () => {
    const sessionId = attachCaller(workerTpl.id);
    const result = await agentEscalate.execute({
      to: managerTpl.id,
      context: "blocker on prod",
      urgency: "high",
      _sessionId: sessionId,
    });
    expect(result.isError).toBeFalsy();
    expect(driverCalls).toHaveLength(1);
    expect(driverCalls[0].templateId).toBe(managerTpl.id);
  });
});

// ── Issue anchoring ──────────────────────────────────────────────────

describe("agent_escalate with issueId", () => {
  it("adds an audit comment on the anchor issue", async () => {
    const issues = IssueStore.getInstance();
    const issue = issues.create({
      title: "blocker test",
      description: "test",
      assignee: workerTpl.id,
      status: "blocked",
      priority: "medium",
      projectId: project.id,
      createdBy: "test",
    });
    createdIssues.push(issue);

    const sessionId = attachCaller(workerTpl.id);
    await agentEscalate.execute({
      to: "user",
      context: "blocked",
      urgency: "high",
      issueId: issue.id,
      _sessionId: sessionId,
    });

    const after = issues.get(issue.id);
    expect(after).not.toBeNull();
    const lastComment = after!.comments[after!.comments.length - 1];
    expect(lastComment.author).toBe("system");
    expect(lastComment.content).toMatch(/Escalated to user/);
  });
});
