/**
 * Regression: spawned agents must receive their identity/coordination tools.
 *
 * resolveToolsForRequest used to gate spawned-agent tools by the `audiences`
 * field first, then "preserve" IDENTITY_TOOLS by filtering the already-gated
 * subset — dead code, because the issue/agent tools carry no audience tag and
 * were dropped by the first gate. A spawned CEO ended up with only audience-tagged
 * tools (read/web_fetch) and could never create an issue or wake an agent,
 * regardless of model. Fix: resolve identity + template tools from the full
 * set, not the audience-filtered subset.
 */
import { describe, it, expect } from "vitest";
import { resolveToolsForRequest } from "../src/tool-search.js";
import type { ToolDefinition, Audience } from "../src/types.js";

function tool(name: string, audiences?: Audience[]): ToolDefinition {
  return {
    name,
    description: name,
    parameters: {},
    execute: async () => ({ content: "" }),
    ...(audiences ? { audiences } : {}),
  };
}

const ALL: ToolDefinition[] = [
  tool("issue_create"),                       // identity, no audience tag, in template
  tool("agent_whoami"),                        // identity, no audience tag, NOT in template
  tool("read", ["spawned-agent"]),             // audience-tagged, in template
  tool("web_fetch", ["spawned-agent"]),        // audience-tagged, in template
  tool("browser_navigate", ["spawned-agent"]), // audience-tagged, NOT in template
  tool("generate_image"),                      // no audience, not identity, not in template
];

const names = (tools: ToolDefinition[]) => new Set(tools.map(t => t.name));

describe("resolveToolsForRequest — spawned-agent provisioning", () => {
  it("delivers identity + template tools even when they carry no audience tag", () => {
    const got = names(
      resolveToolsForRequest(
        { audience: "spawned-agent", templateAllowedTools: ["issue_create", "read", "web_fetch"] },
        ALL,
      ),
    );

    // The bug: these two were silently dropped, breaking every CEO/manager run.
    expect(got.has("issue_create")).toBe(true); // identity + in template
    expect(got.has("agent_whoami")).toBe(true);  // identity, NOT in template — still always granted
    expect(got.has("read")).toBe(true);          // template + audience-tagged
    expect(got.has("web_fetch")).toBe(true);     // template + audience-tagged
  });

  it("still caps the surface: audience-tagged tools outside the template don't leak in", () => {
    const got = names(
      resolveToolsForRequest(
        { audience: "spawned-agent", templateAllowedTools: ["issue_create", "read", "web_fetch"] },
        ALL,
      ),
    );

    expect(got.has("browser_navigate")).toBe(false); // audience-tagged but not allowed/identity
    expect(got.has("generate_image")).toBe(false);   // not allowed, not identity, not audience-tagged
  });
});
