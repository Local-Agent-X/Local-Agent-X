import { describe, it, expect, beforeEach } from "vitest";
import { resolveAgentBrowserProfileId } from "./invoke.js";
import type { AgentDefinition } from "./types.js";
import { ProjectRosterStore } from "../project-rosters.js";

// Mirrors resolveAgentModel's three-rung precedence, for the browser profile:
//   run override → per-project roster → template default → undefined("default")
const baseDef: AgentDefinition = {
  id: "tpl-browser-test",
  name: "Browser Agent",
  role: "browser",
  systemPrompt: "",
  allowedTools: ["browser"],
  description: "",
};

beforeEach(() => ProjectRosterStore._resetForTest());

describe("resolveAgentBrowserProfileId — 3-rung precedence", () => {
  it("rung 1: falls back to the template default", () => {
    const def = { ...baseDef, defaultBrowserProfileId: "prof-template" };
    expect(resolveAgentBrowserProfileId(def, {})).toBe("prof-template");
  });

  it("returns undefined when no rung is set (→ resolves to 'default' downstream)", () => {
    expect(resolveAgentBrowserProfileId(baseDef, {})).toBeUndefined();
  });

  it("rung 2: per-project roster override beats the template default", () => {
    const projectId = "proj-1";
    const roster = ProjectRosterStore.getInstance();
    roster.upsert(projectId, baseDef.id);
    roster.patch(projectId, baseDef.id, { browserProfileId: "prof-project" });
    const def = { ...baseDef, defaultBrowserProfileId: "prof-template" };
    expect(resolveAgentBrowserProfileId(def, { scope: { projectId } })).toBe("prof-project");
  });

  it("rung 2 is skipped without a scope (main chat / headless)", () => {
    const projectId = "proj-2";
    const roster = ProjectRosterStore.getInstance();
    roster.upsert(projectId, baseDef.id);
    roster.patch(projectId, baseDef.id, { browserProfileId: "prof-project" });
    const def = { ...baseDef, defaultBrowserProfileId: "prof-template" };
    // No scope → the roster hit is skipped, template default wins.
    expect(resolveAgentBrowserProfileId(def, {})).toBe("prof-template");
  });

  it("rung 3: the per-run override beats roster and template default", () => {
    const projectId = "proj-3";
    const roster = ProjectRosterStore.getInstance();
    roster.upsert(projectId, baseDef.id);
    roster.patch(projectId, baseDef.id, { browserProfileId: "prof-project" });
    const def = { ...baseDef, defaultBrowserProfileId: "prof-template" };
    expect(
      resolveAgentBrowserProfileId(def, { scope: { projectId }, browserProfileId: "prof-run" }),
    ).toBe("prof-run");
  });
});
