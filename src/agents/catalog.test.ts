import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  AgentTemplateStore,
  ProjectStore,
  type AgentTemplate,
  type Project,
} from "../agent-store/index.js";
import { ProjectRosterStore } from "../project-rosters.js";
import { AgentCatalog } from "./catalog.js";

// The template store seeds a "ceo" template, so the CEO is always
// resolvable by role ("ceo") from the full catalog — that's the
// bootstrap case the fallback must cover. For an id-based fallback
// assertion we also use a builtin with NO seeded template counterpart,
// which the catalog synthesizes as "builtin-<role>": "monitor".
const KNOWN_BUILTIN_ROLE = "monitor"; // synthesized → id "builtin-monitor"

let project: Project;
let memberTpl: AgentTemplate;

beforeEach(() => {
  ProjectRosterStore._resetForTest();
  AgentCatalog._resetForTest();

  const templates = AgentTemplateStore.getInstance();
  memberTpl = templates.create({
    name: `cat-mbr-${Math.random().toString(36).slice(2, 8)}`,
    role: "worker",
    description: "roster member",
    systemPrompt: "",
    allowedTools: ["bash"],
  });

  project = ProjectStore.getInstance().create({
    name: `cat-test-${Math.random().toString(36).slice(2, 8)}`,
    description: "",
    agentIds: [memberTpl.id],
  });
  ProjectRosterStore.getInstance().upsert(project.id, memberTpl.id);
});

afterEach(() => {
  const rosters = ProjectRosterStore.getInstance();
  rosters.remove(project.id, memberTpl.id);
  ProjectStore.getInstance().delete(project.id);
  AgentTemplateStore.getInstance().delete(memberTpl.id);
  ProjectRosterStore._resetForTest();
  AgentCatalog._resetForTest();
});

describe("AgentCatalog soft-resolution fallback", () => {
  it("list(scope) stays roster-scoped (display path)", () => {
    const cat = AgentCatalog.getInstance();
    const scoped = cat.list({ projectId: project.id });
    expect(scoped.map((d) => d.id)).toEqual([memberTpl.id]);
    // A builtin NOT on the roster is excluded from the display view.
    expect(scoped.some((d) => d.id === `builtin-${KNOWN_BUILTIN_ROLE}`)).toBe(false);
  });

  it("list(unknown project) returns an empty team cleanly (no throw)", () => {
    const cat = AgentCatalog.getInstance();
    expect(() => cat.list({ projectId: "does-not-exist-46d6ebc0" })).not.toThrow();
    expect(cat.list({ projectId: "does-not-exist-46d6ebc0" })).toEqual([]);
  });

  it("get() with an UNKNOWN projectId falls back to the full catalog", () => {
    const cat = AgentCatalog.getInstance();
    // Stale/unknown project_id (mirrors the real 46d6ebc0 breakage).
    const ceo = cat.get("ceo", { projectId: "stale-46d6ebc0" });
    expect(ceo).toBeDefined();
    expect(ceo!.role).toBe("ceo");

    const monitor = cat.get(`builtin-${KNOWN_BUILTIN_ROLE}`, { projectId: "stale-46d6ebc0" });
    expect(monitor).toBeDefined();
    expect(monitor!.id).toBe(`builtin-${KNOWN_BUILTIN_ROLE}`);
  });

  it("get() against an EMPTY-roster project still resolves a known agent (bootstrap)", () => {
    const empty = ProjectStore.getInstance().create({
      name: `cat-empty-${Math.random().toString(36).slice(2, 8)}`,
      description: "",
      agentIds: [],
    });
    try {
      const cat = AgentCatalog.getInstance();
      // No roster entries → list(scope) is empty, but the CEO must still
      // resolve so a brand-new project can bootstrap.
      expect(cat.list({ projectId: empty.id })).toEqual([]);
      const ceo = cat.get("ceo", { projectId: empty.id });
      expect(ceo).toBeDefined();
      expect(ceo!.role).toBe("ceo");
    } finally {
      ProjectStore.getInstance().delete(empty.id);
    }
  });

  it("get() for an agent NOT on a populated roster falls back to full catalog", () => {
    const cat = AgentCatalog.getInstance();
    // memberTpl is on the roster; the monitor builtin is not. Spawn-resolve
    // should still find it via fallback.
    const monitor = cat.get(`builtin-${KNOWN_BUILTIN_ROLE}`, { projectId: project.id });
    expect(monitor).toBeDefined();
    expect(monitor!.id).toBe(`builtin-${KNOWN_BUILTIN_ROLE}`);
  });

  it("get() for a populated-project member is unchanged (resolves via scoped path)", () => {
    const cat = AgentCatalog.getInstance();
    const member = cat.get(memberTpl.id, { projectId: project.id });
    expect(member).toBeDefined();
    expect(member!.id).toBe(memberTpl.id);
  });

  it("get() resolves by display name, case-insensitively (orchestrator guesses the label)", () => {
    const cat = AgentCatalog.getInstance();
    // A model that passes the human label "cat-mbr-…" instead of the role
    // slug must still resolve the same agent — this kills the cosmetic
    // 'No agent definition found' failure + retry.
    const byName = cat.get(memberTpl.name, { projectId: project.id });
    expect(byName?.id).toBe(memberTpl.id);
    const byLoudName = cat.get(memberTpl.name.toUpperCase(), { projectId: project.id });
    expect(byLoudName?.id).toBe(memberTpl.id);
  });

  it("get() still returns undefined when nothing in the catalog matches", () => {
    const cat = AgentCatalog.getInstance();
    expect(cat.get("totally-unknown-role-xyz", { projectId: project.id })).toBeUndefined();
    expect(cat.get("totally-unknown-role-xyz")).toBeUndefined();
  });
});
