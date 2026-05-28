import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  AgentRunStore,
  AgentTemplateStore,
  IssueStore,
  ProjectStore,
  type AgentRun,
  type AgentTemplate,
  type Issue,
  type Project,
} from "../agent-store/index.js";
import { ProjectRosterStore } from "../project-rosters.js";
import { EventBus } from "../event-bus.js";
import {
  registerAgentRunDriver,
  _resetAgentRunDriverForTest,
  type AgentRunDriverRequest,
} from "./runtime.js";
import { AgentCatalog } from "./catalog.js";
import { WatchdogService } from "./watchdog.js";

const HOUR = 3_600_000;

let project: Project;
let ceoTpl: AgentTemplate;
let managerTpl: AgentTemplate;
let workerTpl: AgentTemplate;

const driverCalls: AgentRunDriverRequest[] = [];
const escalationEvents: Array<Record<string, unknown>> = [];
let listener: ((d: unknown) => void) | null = null;
const createdIssueIds: string[] = [];
const savedRunIds: string[] = [];

beforeEach(() => {
  driverCalls.length = 0;
  escalationEvents.length = 0;
  ProjectRosterStore._resetForTest();
  WatchdogService._resetForTest();

  const templates = AgentTemplateStore.getInstance();
  ceoTpl = templates.create({
    name: `wd-ceo-${Math.random().toString(36).slice(2, 8)}`,
    role: "ceo", description: "", systemPrompt: "",
    allowedTools: ["agent_escalate"],
  });
  managerTpl = templates.create({
    name: `wd-mgr-${Math.random().toString(36).slice(2, 8)}`,
    role: "manager", description: "", systemPrompt: "",
    allowedTools: ["agent_escalate"],
  });
  workerTpl = templates.create({
    name: `wd-wrk-${Math.random().toString(36).slice(2, 8)}`,
    role: "worker", description: "", systemPrompt: "",
    allowedTools: ["agent_escalate"],
  });

  project = ProjectStore.getInstance().create({
    name: `wd-test-${Math.random().toString(36).slice(2, 8)}`,
    description: "",
    agentIds: [ceoTpl.id, managerTpl.id, workerTpl.id],
  });

  const rosters = ProjectRosterStore.getInstance();
  rosters.upsert(project.id, ceoTpl.id);
  rosters.upsert(project.id, managerTpl.id, { reportsTo: ceoTpl.id });
  rosters.upsert(project.id, workerTpl.id, { reportsTo: managerTpl.id });

  listener = (d: unknown) => { escalationEvents.push(d as Record<string, unknown>); };
  EventBus.on("handler:agent-escalation", listener);

  registerAgentRunDriver(async (req) => {
    driverCalls.push(req);
    return { result: "stub-ok", success: true, tokens: 0 };
  });
});

afterEach(() => {
  if (listener) EventBus.off("handler:agent-escalation", listener);
  listener = null;
  _resetAgentRunDriverForTest();
  WatchdogService._resetForTest();

  const issues = IssueStore.getInstance();
  for (const id of createdIssueIds) issues.delete(id);
  createdIssueIds.length = 0;

  const runs = AgentRunStore.getInstance();
  for (const id of savedRunIds) runs.delete(id);
  savedRunIds.length = 0;

  const templates = AgentTemplateStore.getInstance();
  templates.delete(ceoTpl.id);
  templates.delete(managerTpl.id);
  templates.delete(workerTpl.id);

  // Roster entries are persisted to ~/.lax/project-rosters.json on
  // upsert. _resetForTest() only clears the in-memory singleton, so
  // without explicit removes the file accumulates orphan entries from
  // every test run that ever ran. Remove every entry created in
  // beforeEach before the singleton reset.
  const rosters = ProjectRosterStore.getInstance();
  rosters.remove(project.id, ceoTpl.id);
  rosters.remove(project.id, managerTpl.id);
  rosters.remove(project.id, workerTpl.id);
  ProjectStore.getInstance().delete(project.id);

  ProjectRosterStore._resetForTest();
  AgentCatalog._resetForTest();
});

function makeIssue(assigneeId: string): Issue {
  const issue = IssueStore.getInstance().create({
    title: "wd-test",
    description: "",
    assignee: assigneeId,
    status: "in-progress",
    priority: "medium",
    projectId: project.id,
    createdBy: "test",
  });
  createdIssueIds.push(issue.id);
  return issue;
}

/** Mutate an issue's updatedAt in place. IssueStore.update overwrites
 *  updatedAt with Date.now() so we can't backdate through the public
 *  API; mutating the returned reference is fine for in-process tests. */
function backdateIssue(issue: Issue, hoursAgo: number): void {
  const past = Date.now() - hoursAgo * HOUR;
  issue.updatedAt = past;
  issue.createdAt = past;
}

function backdateRoster(agentId: string, hoursAgo: number): void {
  const r = ProjectRosterStore.getInstance().get(project.id, agentId)!;
  r.createdAt = Date.now() - hoursAgo * HOUR;
}

function saveSyntheticRun(templateId: string, completedAt: number): void {
  const id = `wd-run-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  AgentRunStore.getInstance().save({
    id,
    parentAgentId: null,
    sessionId: "wd-test",
    name: "wd",
    role: "worker",
    task: "test",
    systemPrompt: "",
    status: "succeeded",
    output: [],
    result: "ok",
    toolsUsed: [],
    tokensUsed: 0,
    startedAt: completedAt - 1_000,
    completedAt,
    templateId,
  } as AgentRun);
  savedRunIds.push(id);
}

describe("WatchdogService", () => {
  it("skips an agent with no assigned open issues (idle, not stale)", async () => {
    backdateRoster(workerTpl.id, 100); // would be ancient if idle counted
    const wd = WatchdogService.getInstance();
    await wd.tickNow();
    expect(driverCalls).toHaveLength(0);
    expect(escalationEvents).toHaveLength(0);
  });

  it("does not escalate when the agent is within threshold", async () => {
    makeIssue(workerTpl.id); // updatedAt = now → not stale
    const wd = WatchdogService.getInstance();
    await wd.tickNow();
    expect(driverCalls).toHaveLength(0);
    expect(escalationEvents).toHaveLength(0);
  });

  it("wakes the manager when an agent is exactly at the default 24h threshold", async () => {
    const issue = makeIssue(workerTpl.id);
    backdateIssue(issue, 25); // 25h > 24h, < 48h → manager tier
    backdateRoster(workerTpl.id, 25);

    const wd = WatchdogService.getInstance();
    await wd.tickNow();

    expect(driverCalls).toHaveLength(1);
    expect(driverCalls[0].templateId).toBe(managerTpl.id);
    expect(driverCalls[0].task).toMatch(/escalated to by/i);
  });

  it("escalates past the manager directly to the user at 2x threshold", async () => {
    const issue = makeIssue(workerTpl.id);
    backdateIssue(issue, 49); // 49h > 48h → user tier
    backdateRoster(workerTpl.id, 49);

    const wd = WatchdogService.getInstance();
    await wd.tickNow();

    const userEvents = escalationEvents.filter((e) => e.to === "user");
    expect(userEvents).toHaveLength(1);
    expect(userEvents[0].urgency).toBe("high");
    expect(String(userEvents[0].context)).toMatch(/2x threshold/);
    // user-tier path does NOT wake the manager — that was the 24h tick's job
    expect(driverCalls).toHaveLength(0);
  });

  it("suppresses re-escalation when lastEscalatedAt is inside the current window", async () => {
    const issue = makeIssue(workerTpl.id);
    backdateIssue(issue, 25);
    backdateRoster(workerTpl.id, 25);
    ProjectRosterStore.getInstance().patch(project.id, workerTpl.id, {
      lastEscalatedAt: Date.now() - 60_000, // 1 min ago
    });

    const wd = WatchdogService.getInstance();
    await wd.tickNow();

    expect(driverCalls).toHaveLength(0);
    expect(escalationEvents).toHaveLength(0);
  });

  it("respects a custom stallThresholdHours on the roster", async () => {
    const issue = makeIssue(workerTpl.id);
    backdateIssue(issue, 3);
    backdateRoster(workerTpl.id, 3);
    ProjectRosterStore.getInstance().patch(project.id, workerTpl.id, {
      stallThresholdHours: 2, // 3h > 2h → stale; 3h < 4h → manager tier
    });

    const wd = WatchdogService.getInstance();
    await wd.tickNow();

    expect(driverCalls).toHaveLength(1);
    expect(driverCalls[0].templateId).toBe(managerTpl.id);
  });

  it("uses the max of (runs, issue updates, comments) — a recent run keeps the agent fresh", async () => {
    const issue = makeIssue(workerTpl.id);
    backdateIssue(issue, 30);
    backdateRoster(workerTpl.id, 30);
    // A run that completed 1h ago — newer than anything else, should
    // beat the 30h-old issue update and keep the agent under threshold.
    saveSyntheticRun(workerTpl.id, Date.now() - 1 * HOUR);

    const wd = WatchdogService.getInstance();
    await wd.tickNow();

    expect(driverCalls).toHaveLength(0);
    expect(escalationEvents).toHaveLength(0);
  });

  it("uses the max — a recent comment by the agent keeps it fresh even if the issue.updatedAt is old", async () => {
    const issue = makeIssue(workerTpl.id);
    // Push the comment by hand so we don't trigger IssueStore.comment()
    // refreshing issue.updatedAt — we want to assert the COMMENT, not
    // the issue, is what saved the agent.
    issue.comments.push({
      id: "wd-c",
      author: workerTpl.id,
      content: "still on it",
      createdAt: Date.now() - 1 * HOUR,
    });
    backdateIssue(issue, 30);
    backdateRoster(workerTpl.id, 30);

    const wd = WatchdogService.getInstance();
    await wd.tickNow();

    expect(driverCalls).toHaveLength(0);
  });

  it("releases the running flag even when the sweep throws", async () => {
    const rs = ProjectRosterStore.getInstance();
    const orig = rs.listAll.bind(rs);
    rs.listAll = () => { throw new Error("boom"); };
    try {
      const wd = WatchdogService.getInstance();
      await wd.tickNow();
      expect(wd.isRunning()).toBe(false);
    } finally {
      rs.listAll = orig;
    }
  });

  it("manual smoke equivalent — open issue + 25h fake age + tick → manager wake observed", async () => {
    const issue = makeIssue(workerTpl.id);
    backdateIssue(issue, 25);
    backdateRoster(workerTpl.id, 25);

    const wd = WatchdogService.getInstance();
    await wd.tickNow();

    // Manager was woken via the canonical driver path.
    expect(driverCalls).toHaveLength(1);
    expect(driverCalls[0].templateId).toBe(managerTpl.id);
    // Dedup marker landed.
    const roster = ProjectRosterStore.getInstance().get(project.id, workerTpl.id)!;
    expect(roster.lastEscalatedAt).toBeDefined();
    expect(Date.now() - roster.lastEscalatedAt!).toBeLessThan(5_000);
  });
});
