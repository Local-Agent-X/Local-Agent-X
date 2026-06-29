/**
 * Regression for the dual-agent build duplication: a "build me a Rust program"
 * ask forced build_app (spawning the background worker) but the MAIN agent ALSO
 * built it inline — it ran cargo + write + send_image itself, producing a second
 * copy at workspace/<id>/ alongside the worker's apps/<id>/ build.
 *
 * The fix is a hard, provider-agnostic guarantee: when build_app is force-pinned,
 * strip the inline-build tools from the turn's toolset so the main agent CANNOT
 * build it itself. build_app survives (tool_choice forcing pins it); read-only
 * tools survive (they can't build). The build-intent narrowing alone did NOT do
 * this — its audience set deliberately keeps bash/write/edit.
 */
import { describe, it, expect } from "vitest";
import { stripInlineBuildTools } from "../src/agent-request/prepare-request/tool-selection.js";
import type { ToolDefinition } from "../src/types.js";

const tool = (name: string): ToolDefinition => ({
  name,
  description: name,
  parameters: { type: "object", properties: {} },
});

// The shape a forced-build turn might carry: build_app + the inline-build tools
// the model would (wrongly) use to build inline + harmless read-only/other tools.
const FULL = [
  "build_app", "bash", "write", "edit", "edit_lines", "multi_edit",
  "process_start", "process_status", "process_kill", "send_image",
  "connector_create", "app_serve_backend", "self_edit",
  "read", "glob", "grep", "web_search", "search_past_sessions",
].map(tool);

describe("stripInlineBuildTools — the dual-build hard guarantee", () => {
  it("removes every tool the agent could build inline with", () => {
    const out = stripInlineBuildTools(FULL, FULL).map((t) => t.name);
    for (const denied of [
      "bash", "write", "edit", "edit_lines", "multi_edit",
      "process_start", "process_status", "process_kill",
      "send_image", "connector_create", "app_serve_backend", "self_edit",
    ]) {
      expect(out).not.toContain(denied);
    }
  });

  it("keeps build_app — tool_choice forcing must still resolve", () => {
    expect(stripInlineBuildTools(FULL, FULL).map((t) => t.name)).toContain("build_app");
  });

  it("re-adds build_app from the full catalog if a prior narrowing dropped it", () => {
    const withoutBuildApp = FULL.filter((t) => t.name !== "build_app");
    const out = stripInlineBuildTools(withoutBuildApp, FULL).map((t) => t.name);
    expect(out).toContain("build_app");
  });

  it("keeps read-only and unrelated tools — they cannot build an app", () => {
    const out = stripInlineBuildTools(FULL, FULL).map((t) => t.name);
    for (const kept of ["read", "glob", "grep", "web_search", "search_past_sessions"]) {
      expect(out).toContain(kept);
    }
  });

  it("does not duplicate build_app when it is already present", () => {
    const names = stripInlineBuildTools(FULL, FULL).map((t) => t.name);
    expect(names.filter((n) => n === "build_app")).toHaveLength(1);
  });
});
