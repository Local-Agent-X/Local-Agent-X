// A dispatch whose caller passed no tool policy is judged by the installed one,
// never waved through. Autopilot rounds and the app-build sub-agent passed
// none, and a missing policy used to allow every tool (2026-11-01).
import { beforeAll, afterAll, describe, expect, it } from "vitest";
import { setAriRequired } from "../ari-kernel/state.js";
import type { ToolDefinition } from "../types.js";
import { executeToolCalls } from "./execute-tool.js";
import { installedToolPolicy } from "../tool-policy/index.js";
import { withStubTools } from "./stub-tool-policy.test-helper.js";

const ran: string[] = [];
const tool = (name: string): ToolDefinition => ({
  name,
  description: "",
  parameters: { type: "object", properties: {} },
  execute: async () => { ran.push(name); return { content: "ran" }; },
} as unknown as ToolDefinition);

async function dispatch(name: string, policy?: Parameters<typeof executeToolCalls>[3]) {
  const msgs = await executeToolCalls(
    [{ id: `c-${name}-${ran.length}`, name, arguments: "{}" }],
    new Map([[name, tool(name)]]), undefined as never, policy, undefined, undefined, undefined,
    `s-no-policy-${name}`, undefined, undefined, undefined, undefined, undefined, "delegated",
  );
  return String(msgs.find((m) => m.role === "tool")?.content ?? "");
}

describe("dispatch with no tool policy", () => {
  beforeAll(() => setAriRequired(false));
  afterAll(() => setAriRequired(true));

  it("refuses a tool the installed policy has no rule for", async () => {
    const out = await dispatch("unlisted_tool");
    expect(out).toContain('layer="tool-policy"');
    expect(ran).not.toContain("unlisted_tool");
  });

  it("runs it when the caller's own policy allows it", async () => {
    await dispatch("listed_tool", withStubTools(["listed_tool"]));
    expect(ran).toContain("listed_tool");
  });

  it("is one installed policy per data dir, not a new watcher per dispatch", () => {
    expect(installedToolPolicy()).toBe(installedToolPolicy());
  });
});
