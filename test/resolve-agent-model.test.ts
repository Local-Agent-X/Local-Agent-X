/**
 * Pins the resolveAgentModel chain — the four-rung lookup that decides
 * which provider+model an agent run uses BEFORE the global default
 * picker in resolveProvider gets a vote.
 *
 *   1. opts.modelOverride  (per-run pin)
 *   2. roster.model        (per-project pin)
 *   3. def.defaultModel    (template-level pin)
 *   4. the parent chat's pin (session/model-pin.ts)
 *   5. undefined           (fall through to global default)
 *
 * Each test isolates one rung and asserts the higher rungs win. The
 * ProjectRosterStore fixture mirrors project-rosters.test.ts: back up
 * the real install's data, write an empty map, _resetForTest, restore
 * in afterEach.
 */

import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { homedir, tmpdir } from "node:os";

import { resolveAgentModel } from "../src/agents/invoke.js";
import { ProjectRosterStore } from "../src/project-rosters.js";
import { createModelPinStore } from "../src/session/model-pin.js";
import type { AgentDefinition } from "../src/agents/types.js";

const ROSTERS_FILE = join(homedir(), ".lax", "project-rosters.json");

const BASE_DEF: AgentDefinition = {
  id: "tpl-test-agent",
  name: "Test Agent",
  role: "tester",
  systemPrompt: "Test.",
  allowedTools: ["read"],
  description: "Fixture for resolveAgentModel chain tests.",
};

let backupContents: string | null = null;

describe("resolveAgentModel — four-rung lookup chain", () => {
  beforeEach(() => {
    backupContents = existsSync(ROSTERS_FILE) ? readFileSync(ROSTERS_FILE, "utf-8") : null;
    writeFileSync(ROSTERS_FILE, "{}", "utf-8");
    ProjectRosterStore._resetForTest();
  });

  afterEach(() => {
    if (backupContents !== null) writeFileSync(ROSTERS_FILE, backupContents, "utf-8");
    else if (existsSync(ROSTERS_FILE)) unlinkSync(ROSTERS_FILE);
    backupContents = null;
    ProjectRosterStore._resetForTest();
  });

  it("returns undefined when no rung has a value", () => {
    const def: AgentDefinition = { ...BASE_DEF };
    expect(resolveAgentModel(def, {})).toBeUndefined();
  });

  it("rung 3: template defaultModel wins when nothing higher is set", () => {
    const def: AgentDefinition = { ...BASE_DEF, defaultModel: { provider: "anthropic", model: "claude-sonnet-4-6" } };
    const pin = resolveAgentModel(def, {});
    expect(pin).toEqual({ provider: "anthropic", model: "claude-sonnet-4-6" });
  });

  it("rung 3 is skipped when no scope is provided, even if a roster entry exists", () => {
    // Without scope, the roster lookup can't run — only the template
    // default is consulted. Verifies we don't accidentally read a
    // project-scoped value into a project-less invocation.
    ProjectRosterStore.getInstance().upsert("proj-A", BASE_DEF.id);
    ProjectRosterStore.getInstance().patch("proj-A", BASE_DEF.id, {
      model: { provider: "codex", model: "gpt-5.5" },
    });
    const def: AgentDefinition = { ...BASE_DEF, defaultModel: { provider: "anthropic", model: "claude-opus-4-7" } };
    expect(resolveAgentModel(def, {})).toEqual({ provider: "anthropic", model: "claude-opus-4-7" });
  });

  it("rung 2: roster.model beats template defaultModel when scope is set", () => {
    ProjectRosterStore.getInstance().upsert("proj-A", BASE_DEF.id);
    ProjectRosterStore.getInstance().patch("proj-A", BASE_DEF.id, {
      model: { provider: "codex", model: "gpt-5.5" },
    });
    const def: AgentDefinition = { ...BASE_DEF, defaultModel: { provider: "anthropic", model: "claude-opus-4-7" } };
    const pin = resolveAgentModel(def, { scope: { projectId: "proj-A" } });
    expect(pin).toEqual({ provider: "codex", model: "gpt-5.5" });
  });

  it("rung 2: falls through to template when scope is set but roster has no model pin", () => {
    ProjectRosterStore.getInstance().upsert("proj-A", BASE_DEF.id);
    const def: AgentDefinition = { ...BASE_DEF, defaultModel: { provider: "anthropic", model: "claude-haiku-4-5" } };
    expect(resolveAgentModel(def, { scope: { projectId: "proj-A" } }))
      .toEqual({ provider: "anthropic", model: "claude-haiku-4-5" });
  });

  it("rung 1: opts.modelOverride beats roster AND template", () => {
    ProjectRosterStore.getInstance().upsert("proj-A", BASE_DEF.id);
    ProjectRosterStore.getInstance().patch("proj-A", BASE_DEF.id, {
      model: { provider: "codex", model: "gpt-5.5" },
    });
    const def: AgentDefinition = { ...BASE_DEF, defaultModel: { provider: "anthropic", model: "claude-opus-4-7" } };
    const pin = resolveAgentModel(def, {
      scope: { projectId: "proj-A" },
      modelOverride: { provider: "xai", model: "grok-4" },
    });
    expect(pin).toEqual({ provider: "xai", model: "grok-4" });
  });

  it("clearing roster.model (sentinel: null) falls through to template default", () => {
    // Mirror the UI's clear flow: PATCH with model:null wipes the
    // per-project override. After clearing, the chain should resolve
    // back to the template default.
    ProjectRosterStore.getInstance().upsert("proj-A", BASE_DEF.id);
    ProjectRosterStore.getInstance().patch("proj-A", BASE_DEF.id, {
      model: { provider: "codex", model: "gpt-5.5" },
    });
    ProjectRosterStore.getInstance().patch("proj-A", BASE_DEF.id, { model: null });
    const def: AgentDefinition = { ...BASE_DEF, defaultModel: { provider: "anthropic", model: "claude-sonnet-4-6" } };
    expect(resolveAgentModel(def, { scope: { projectId: "proj-A" } }))
      .toEqual({ provider: "anthropic", model: "claude-sonnet-4-6" });
  });
});

describe("resolveAgentModel — the parent chat's model", () => {
  // A throwaway pin file, never the install's session-model-pins.json.
  const dir = mkdtempSync(join(tmpdir(), "resolve-agent-model-pins-"));
  const pins = createModelPinStore(join(dir, "pins.json"));
  pins.set("chat-opus", { provider: "anthropic", model: "claude-opus-5-5" });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it("an agent a chat starts runs on the model picked in that chat", () => {
    expect(resolveAgentModel({ ...BASE_DEF }, { parentSessionId: "chat-opus" }, pins))
      .toEqual({ provider: "anthropic", model: "claude-opus-5-5" });
  });

  it("a chat with no pin, or a run with no parent chat, falls through to the global default", () => {
    expect(resolveAgentModel({ ...BASE_DEF }, { parentSessionId: "chat-unpinned" }, pins)).toBeUndefined();
    expect(resolveAgentModel({ ...BASE_DEF }, {}, pins)).toBeUndefined();
  });

  it("an explicit run pick or a template's own model still wins over the chat's", () => {
    const templated: AgentDefinition = { ...BASE_DEF, defaultModel: { provider: "xai", model: "grok-4.5" } };
    expect(resolveAgentModel(templated, { parentSessionId: "chat-opus" }, pins)).toEqual({ provider: "xai", model: "grok-4.5" });
    expect(resolveAgentModel({ ...BASE_DEF }, { parentSessionId: "chat-opus", modelOverride: { provider: "codex", model: "gpt-5.5" } }, pins))
      .toEqual({ provider: "codex", model: "gpt-5.5" });
  });
});
