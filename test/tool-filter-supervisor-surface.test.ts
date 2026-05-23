/**
 * Pins the supervisor's tool surface contract — the gate that decides
 * which tools Primal (the chat-side LLM) actually sees.
 *
 * Two invariants this test enforces, both load-bearing for the
 * canonical-agent design (see docs/canonical-agent-design.md Q1):
 *
 *   1. The canonical delegation tools (agent_list, agent_spawn,
 *      agent_create) are INCLUDED. Without them, the supervisor can't
 *      delegate at all — and that's exactly the bug that nullified
 *      L1–L5 before this test existed.
 *
 *   2. The legacy worker-pool submission tools (op_submit,
 *      op_submit_async, op_wait) are EXCLUDED. Delegation routes
 *      through agent_spawn; internal callers can still invoke submitOp
 *      programmatically, but the LLM-facing tool surface must not let
 *      the supervisor pick the old path.
 *
 * Observation-only worker-pool tools (op_status, op_kill, op_redirect)
 * remain available so the supervisor can watch + cancel ops kicked off
 * by autopilot or scheduled tasks. Those are not delegation primitives.
 */

import { describe, it, expect } from "vitest";
import type { ToolDefinition } from "../src/types.js";
import { filterToolsForMessage } from "../src/agent-request/tool-filter.js";
import { applyAudiences } from "../src/tools/audience-map.js";

function fakeTool(name: string): ToolDefinition {
  return {
    name,
    description: `fixture: ${name}`,
    parameters: { type: "object", properties: {}, required: [] },
    async execute() { return { content: "" }; },
  };
}

const TOOLS_OF_INTEREST = [
  "agent_list", "agent_spawn", "agent_create",
  "agent_status", "agent_cancel", "agent_output",
  "op_submit", "op_submit_async", "op_wait",
  "op_status", "op_kill", "op_redirect",
  // agency_* is the legacy heavyweight delegation path that overlaps
  // with agent_spawn. SUPERVISOR_EXCLUDED keeps it out of Primal's surface.
  "agency_create", "agency_status", "agency_cancel",
  // Carry a few core tools so the filter has signal to work with.
  "read", "write", "bash", "web_fetch", "tool_search",
];

// Real tools get their `audiences` field stamped by registry-build.ts via
// applyAudiences (reads src/tools/audience-map.ts). The canonical resolver
// then filters by audience. Bare fixtures with no audiences would all get
// filtered out — testing the resolver in isolation rather than the
// supervisor-surface invariant we actually care about. So run the same
// stamper production uses.
const SAMPLE_TOOLS = TOOLS_OF_INTEREST.map(fakeTool);
applyAudiences(SAMPLE_TOOLS);

describe("supervisor tool surface — canonical delegation included, op-submit excluded", () => {
  it("includes agent_list / agent_spawn / agent_create on a normal message", () => {
    const filtered = filterToolsForMessage(SAMPLE_TOOLS, "spawn an agent to research american eagles");
    const names = new Set(filtered.map(t => t.name));
    expect(names.has("agent_list")).toBe(true);
    expect(names.has("agent_spawn")).toBe(true);
    expect(names.has("agent_create")).toBe(true);
  });

  it("excludes op_submit / op_submit_async / op_wait on a normal message", () => {
    const filtered = filterToolsForMessage(SAMPLE_TOOLS, "spawn an agent to research american eagles");
    const names = new Set(filtered.map(t => t.name));
    expect(names.has("op_submit")).toBe(false);
    expect(names.has("op_submit_async")).toBe(false);
    expect(names.has("op_wait")).toBe(false);
  });

  it("keeps observation-only worker-pool tools (op_status / op_kill / op_redirect)", () => {
    const filtered = filterToolsForMessage(SAMPLE_TOOLS, "hello");
    const names = new Set(filtered.map(t => t.name));
    expect(names.has("op_status")).toBe(true);
    expect(names.has("op_kill")).toBe(true);
    expect(names.has("op_redirect")).toBe(true);
  });

  it("keeps the agent_status / agent_cancel / agent_output observability tools", () => {
    const filtered = filterToolsForMessage(SAMPLE_TOOLS, "hello");
    const names = new Set(filtered.map(t => t.name));
    expect(names.has("agent_status")).toBe(true);
    expect(names.has("agent_cancel")).toBe(true);
    expect(names.has("agent_output")).toBe(true);
  });

  it("build-intent messages still expose agent_spawn (not op_submit_async)", () => {
    const filtered = filterToolsForMessage(SAMPLE_TOOLS, "build me an app for tracking workouts");
    const names = new Set(filtered.map(t => t.name));
    expect(names.has("agent_spawn")).toBe(true);
    expect(names.has("agent_list")).toBe(true);
    expect(names.has("op_submit_async")).toBe(false);
    expect(names.has("op_submit")).toBe(false);
  });

  it("excludes agency_create / agency_status / agency_cancel on a spawn-style message", () => {
    // The canonical delegation surface is agent_list / agent_spawn / agent_create.
    // agency_create overlaps semantically and Claude (Anthropic) tends to pick
    // the heavier path when both are visible. Stay off Primal's surface.
    const filtered = filterToolsForMessage(SAMPLE_TOOLS, "spawn a researcher agent to find the capital of France");
    const names = new Set(filtered.map(t => t.name));
    expect(names.has("agency_create")).toBe(false);
    expect(names.has("agency_status")).toBe(false);
    expect(names.has("agency_cancel")).toBe(false);
    // And the canonical path is still present so delegation still works.
    expect(names.has("agent_spawn")).toBe(true);
  });

  it("excludes agency_* even on messages with `agency`/`team`/`hire` keywords", () => {
    // The keyword router has /agency|team|hire/i → agency_ prefix as a legacy
    // shortcut. SUPERVISOR_EXCLUDED filters those back out regardless.
    const filtered = filterToolsForMessage(SAMPLE_TOOLS, "set up an agency to hire a team");
    const names = new Set(filtered.map(t => t.name));
    expect(names.has("agency_create")).toBe(false);
    expect(names.has("agency_status")).toBe(false);
  });
});
