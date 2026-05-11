/**
 * Pins the canonical agent layer contract:
 *
 *   1. AgentCatalog.list() is the superset of both legacy sources
 *      (BUILT_IN_ROLES + AgentTemplateStore seedDefaults). Roles that
 *      exist in both appear once; roles only in one source still appear.
 *
 *   2. AgentCatalog.get() resolves by canonical id AND by role slug —
 *      both forms must work during the migration.
 *
 *   3. invokeAgent() throws AgentNotFoundError for unknown names,
 *      not a generic Error — callers can catch the specific shape.
 *
 * Why this is the canonical contract: every future consumer (delegate
 * tool, agency_list_roles, CEO heartbeat, agents UI) is going to
 * dispatch through this layer. Breaking the merge logic silently fails
 * downstream consumers by name. These tests make that loud.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { AgentCatalog } from "../src/agents/catalog.js";
import { invokeAgent, AgentNotFoundError, applyProjectToolGate } from "../src/agents/invoke.js";
import { createAgentTools } from "../src/agents/tools.js";
import { _seedBuiltinRoles } from "../src/agency/agent-roles.js";
import { AgentTemplateStore, ProjectStore } from "../src/agent-store.js";

describe("AgentCatalog — superset merge of legacy sources", () => {
  beforeEach(() => {
    AgentCatalog._resetForTest();
  });

  it("returns a superset of templates and built-in roles", () => {
    const templates = AgentTemplateStore.getInstance().list();
    const roles = _seedBuiltinRoles();
    const list = AgentCatalog.getInstance().list();

    // Every legacy template should be in the catalog (by id).
    for (const t of templates) {
      expect(list.some((d) => d.id === t.id)).toBe(true);
    }

    // Every legacy role should be reachable in the catalog (by role
    // slug — id may be "builtin-<role>" or a template id covering it).
    for (const r of roles) {
      expect(list.some((d) => d.role === r.name)).toBe(true);
    }
  });

  it("dedupes when the same role appears in both sources (template wins)", () => {
    const list = AgentCatalog.getInstance().list();
    // "researcher" exists in BUILT_IN_ROLES AND as builtin-researcher
    // template. Catalog should show exactly one entry for that role.
    const researchers = list.filter((d) => d.role === "researcher");
    expect(researchers).toHaveLength(1);
    // Template version wins — id has the template shape, not "builtin-researcher"
    // (the templates seedDefaults use id "builtin-researcher" too, so this
    // test mostly proves the merge doesn't double-count).
    expect(researchers[0].id).toBe("builtin-researcher");
  });

  it("includes role-only entries (no template covers them)", () => {
    const list = AgentCatalog.getInstance().list();
    // "monitor", "designer", "ops", "communicator", "social-media" exist
    // only in BUILT_IN_ROLES — pick one and confirm it surfaces with the
    // synthesized id shape.
    const monitor = list.find((d) => d.role === "monitor");
    expect(monitor).toBeDefined();
    expect(monitor!.id).toBe("builtin-monitor");
    expect(monitor!.allowedTools.length).toBeGreaterThan(0);
  });

  it("includes template-only entries (no role covers them)", () => {
    const list = AgentCatalog.getInstance().list();
    // "ceo", "deep-researcher", "browser", "sysadmin" exist only as
    // templates — confirm one surfaces.
    const ceo = list.find((d) => d.role === "ceo");
    expect(ceo).toBeDefined();
    expect(ceo!.id).toBe("builtin-ceo");
    expect(ceo!.icon).toBe("👔");
  });

  it("strips org metadata from templates (hired/reportsTo/budget)", () => {
    const list = AgentCatalog.getInstance().list();
    const researcher = list.find((d) => d.role === "researcher");
    expect(researcher).toBeDefined();
    // AgentDefinition shape has no hired/reportsTo/heartbeat fields.
    // These belong on OrganizationMember, not on the definition.
    expect(researcher).not.toHaveProperty("hired");
    expect(researcher).not.toHaveProperty("reportsTo");
    expect(researcher).not.toHaveProperty("heartbeatSchedule");
    expect(researcher).not.toHaveProperty("budget");
  });
});

describe("AgentCatalog.get — id and role slug both resolve", () => {
  beforeEach(() => {
    AgentCatalog._resetForTest();
  });

  it("resolves by role slug", () => {
    const r = AgentCatalog.getInstance().get("researcher");
    expect(r).toBeDefined();
    expect(r!.role).toBe("researcher");
  });

  it("resolves by canonical id", () => {
    const r = AgentCatalog.getInstance().get("builtin-researcher");
    expect(r).toBeDefined();
    expect(r!.role).toBe("researcher");
  });

  it("returns undefined for unknown names", () => {
    expect(AgentCatalog.getInstance().get("nonsense-agent")).toBeUndefined();
  });
});

describe("invokeAgent — error shape", () => {
  it("throws AgentNotFoundError for unknown ids", () => {
    expect(() => invokeAgent("does-not-exist", "do a thing")).toThrow(AgentNotFoundError);
  });

  it("AgentNotFoundError carries the requested name in the message", () => {
    try {
      invokeAgent("does-not-exist", "do a thing");
      throw new Error("expected throw");
    } catch (e) {
      expect(e).toBeInstanceOf(AgentNotFoundError);
      expect((e as Error).message).toContain("does-not-exist");
    }
  });
});

describe("AgentCatalog — project scoping", () => {
  let testProjectId: string | null = null;

  beforeEach(() => {
    AgentCatalog._resetForTest();
  });

  afterEach(() => {
    if (testProjectId) {
      ProjectStore.getInstance().delete(testProjectId);
      testProjectId = null;
    }
  });

  function createTestProject(agentIds: string[], allowedTools?: string[]): string {
    const p = ProjectStore.getInstance().create({
      name: "test-scope-fixture",
      description: "transient fixture for canonical scoping tests",
      agentIds,
      ...(allowedTools !== undefined ? { allowedTools } : {}),
    });
    testProjectId = p.id;
    return p.id;
  }

  it("list(scope) filters to the project's roster", () => {
    const projectId = createTestProject(["builtin-researcher", "builtin-writer"]);
    const scoped = AgentCatalog.getInstance().list({ projectId });
    expect(scoped).toHaveLength(2);
    const ids = scoped.map((d) => d.id).sort();
    expect(ids).toEqual(["builtin-researcher", "builtin-writer"]);
  });

  it("list(scope) returns empty for a non-existent project", () => {
    const scoped = AgentCatalog.getInstance().list({ projectId: "proj-does-not-exist" });
    expect(scoped).toEqual([]);
  });

  it("list(scope) silently skips roster ids the catalog doesn't recognize", () => {
    const projectId = createTestProject(["builtin-researcher", "tpl-ghost-agent-deleted"]);
    const scoped = AgentCatalog.getInstance().list({ projectId });
    expect(scoped).toHaveLength(1);
    expect(scoped[0].id).toBe("builtin-researcher");
  });

  it("get(role, scope) resolves only agents on the roster", () => {
    const projectId = createTestProject(["builtin-researcher"]);
    expect(AgentCatalog.getInstance().get("researcher", { projectId })?.id).toBe("builtin-researcher");
    expect(AgentCatalog.getInstance().get("ceo", { projectId })).toBeUndefined();
  });

  it("invokeAgent throws AgentNotFoundError when the agent isn't on the project roster", () => {
    const projectId = createTestProject(["builtin-researcher"]);
    // CEO exists in the global catalog but not on this project — scoped
    // lookup must miss, otherwise the org boundary is purely decorative.
    expect(() => invokeAgent("ceo", "do a thing", { scope: { projectId } })).toThrow(AgentNotFoundError);
  });
});

describe("createAgentTools — three primitives for delegating agents", () => {
  it("exposes exactly agent_list, agent_spawn, agent_create", () => {
    const names = createAgentTools().map((t) => t.name).sort();
    expect(names).toEqual(["agent_create", "agent_list", "agent_spawn"]);
  });

  it("agent_list returns formatted catalog rows", async () => {
    const tool = createAgentTools().find((t) => t.name === "agent_list");
    expect(tool).toBeDefined();
    const res = await tool!.execute({}, new AbortController().signal);
    expect(res.isError).toBeFalsy();
    expect(res.content).toContain("Researcher");
    expect(res.content).toContain("role: researcher");
  });

  it("agent_spawn rejects unknown agents with AgentNotFoundError text", async () => {
    const tool = createAgentTools().find((t) => t.name === "agent_spawn");
    expect(tool).toBeDefined();
    const res = await tool!.execute({ agent: "does-not-exist", task: "x" }, new AbortController().signal);
    expect(res.isError).toBe(true);
    expect(res.content).toContain("does-not-exist");
  });

  it("agent_create rejects empty allowed_tools", async () => {
    const tool = createAgentTools().find((t) => t.name === "agent_create");
    expect(tool).toBeDefined();
    const res = await tool!.execute(
      { name: "x", role: "x", system_prompt: "x", allowed_tools: [] },
      new AbortController().signal,
    );
    expect(res.isError).toBe(true);
    expect(res.content).toContain("allowed_tools");
  });

  it("agent_create adds a new agent to the catalog and makes it visible to agent_list", async () => {
    AgentCatalog._resetForTest();
    const tools = createAgentTools();
    const create = tools.find((t) => t.name === "agent_create")!;
    const list = tools.find((t) => t.name === "agent_list")!;

    const created = await create.execute({
      name: "Test Compliance Reviewer",
      role: "test-compliance-reviewer",
      system_prompt: "Review for compliance gaps.",
      allowed_tools: ["read", "write"],
      description: "Test fixture — delete after test",
    }, new AbortController().signal);
    expect(created.isError).toBeFalsy();

    try {
      const after = await list.execute({}, new AbortController().signal);
      expect(after.content).toContain("Test Compliance Reviewer");
      expect(after.content).toContain("role: test-compliance-reviewer");
    } finally {
      // Cleanup — find the fixture and delete it. AgentTemplateStore.create
      // assigns a "tpl-<rand>" id; we locate it by role since that's stable.
      const store = AgentTemplateStore.getInstance();
      const fixture = store.list().find((t) => t.role === "test-compliance-reviewer");
      if (fixture) store.delete(fixture.id);
      AgentCatalog._resetForTest();
    }
  });
});

describe("applyProjectToolGate — tool intersection", () => {
  let testProjectId: string | null = null;

  afterEach(() => {
    if (testProjectId) {
      ProjectStore.getInstance().delete(testProjectId);
      testProjectId = null;
    }
  });

  function createProjectWithTools(allowedTools: string[] | undefined): string {
    const p = ProjectStore.getInstance().create({
      name: "test-tool-gate-fixture",
      description: "transient fixture",
      agentIds: [],
      ...(allowedTools !== undefined ? { allowedTools } : {}),
    });
    testProjectId = p.id;
    return p.id;
  }

  it("no scope → full surface unchanged", () => {
    const out = applyProjectToolGate(["a", "b", "c"], {});
    expect(out).toEqual(["a", "b", "c"]);
  });

  it("scope with no project.allowedTools → full surface unchanged", () => {
    const projectId = createProjectWithTools(undefined);
    const out = applyProjectToolGate(["a", "b", "c"], { scope: { projectId } });
    expect(out).toEqual(["a", "b", "c"]);
  });

  it("scope with empty project.allowedTools → full surface unchanged", () => {
    // Empty array means "no restriction declared," same as undefined.
    // A project owner who wants to grant nothing must use a different
    // mechanism — this is a deliberate ergonomic choice so a default
    // {allowedTools: []} doesn't accidentally lock every agent out.
    const projectId = createProjectWithTools([]);
    const out = applyProjectToolGate(["a", "b", "c"], { scope: { projectId } });
    expect(out).toEqual(["a", "b", "c"]);
  });

  it("intersects when project.allowedTools is set", () => {
    const projectId = createProjectWithTools(["read", "write"]);
    const out = applyProjectToolGate(["read", "write", "bash", "edit"], { scope: { projectId } });
    expect(out).toEqual(["read", "write"]);
  });
});
