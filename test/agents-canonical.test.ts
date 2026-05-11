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

import { describe, it, expect, beforeEach } from "vitest";
import { AgentCatalog } from "../src/agents/catalog.js";
import { invokeAgent, AgentNotFoundError } from "../src/agents/invoke.js";
import { _seedBuiltinRoles } from "../src/agency/agent-roles.js";
import { AgentTemplateStore } from "../src/agent-store.js";

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
