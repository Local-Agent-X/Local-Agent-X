/**
 * Regression: the delegated-worker denylist must hold at tool_search
 * AUGMENTATION time, not only at spawn time.
 *
 * W2 gave delegated workers a curated read/search belt (spawn-time
 * subtraction). But `tool_search` can re-acquire ANY registry tool at
 * runtime: augmentFromToolSearch unions discovered tools into the executable
 * toolMap + registerToolsForOp. Without a re-check, a "read-only" worker could
 * tool_search its way back to op_submit_async (unbounded fan-out),
 * mission_schedule_* (unattended cron), or write/edit.
 *
 * These tests prove the fix: when callContext === "delegated", discovered
 * tools pass through the SAME isDeniedForDelegatedWorker predicate (one source
 * of truth). Non-delegated contexts ("api") stay unfiltered — proving no
 * behavior change off the delegated path.
 *
 * The registry is the live unifiedRegistry singleton (no second registry is
 * constructed) — each test registers exactly the tools it needs and
 * unregisters them afterwards.
 */
import { afterEach, describe, expect, it } from "vitest";
import type { Audience, ToolDefinition } from "../src/types.js";
import { unifiedRegistry } from "../src/tools/registry.js";
import { augmentFromToolSearch } from "../src/canonical-loop/chat-tool-dispatcher.js";
import { getToolsForOp, unregisterToolsForOp } from "../src/canonical-loop/runtime.js";

const registered: string[] = [];
const ops: string[] = [];

function mkTool(name: string): ToolDefinition {
  return {
    name,
    description: `test tool ${name}`,
    parameters: { type: "object", properties: {} },
    execute: async () => ({ content: "ok" }),
    audiences: ["spawned-agent"] as Audience[],
  };
}

function registerAll(names: string[]): void {
  for (const name of names) {
    unifiedRegistry.register(mkTool(name));
    registered.push(name);
  }
}

/** tool_search's on-the-wire output: a JSON array of tool schemas. */
function toolSearchResult(names: string[]): string {
  return JSON.stringify(names.map((name) => ({
    name,
    description: `test tool ${name}`,
    parameters: { type: "object", properties: {} },
  })));
}

afterEach(() => {
  for (const name of registered.splice(0)) unifiedRegistry.unregister(name);
  for (const opId of ops.splice(0)) unregisterToolsForOp(opId);
});

describe("augmentFromToolSearch delegated denylist", () => {
  // A denied tool (op_submit_async — unbounded fan-out) and a benign
  // read-only tool discovered in the same tool_search result.
  const DENIED = "op_submit_async";
  const ALLOWED = "fake_read_only";

  it("drops denied tools when callContext is 'delegated', keeps allowed ones", () => {
    registerAll([DENIED, ALLOWED, "write"]);
    const opId = "op_delegated_test_0001";
    ops.push(opId);
    const toolMap = new Map<string, ToolDefinition>();
    let augmentedNames: string[] = [];

    augmentFromToolSearch(
      toolSearchResult([DENIED, "write", ALLOWED]),
      opId,
      toolMap,
      (tools) => { augmentedNames = tools.map((t) => t.name); },
      "delegated",
    );

    // Denied tools never enter the executable toolMap...
    expect(toolMap.has(DENIED)).toBe(false);
    expect(toolMap.has("write")).toBe(false);
    // ...nor the schema-visible augmentation the model would next see.
    expect(augmentedNames).not.toContain(DENIED);
    expect(augmentedNames).not.toContain("write");
    // The benign read-only tool passes through.
    expect(toolMap.has(ALLOWED)).toBe(true);
    expect(augmentedNames).toContain(ALLOWED);
    // And is re-registered on the op so the next request schema includes it.
    expect(getToolsForOp(opId).map((t) => t.name)).toEqual([ALLOWED]);
  });

  it("leaves discovery unfiltered for non-delegated context ('api')", () => {
    registerAll([DENIED, ALLOWED, "write"]);
    const opId = "op_api_test_0001";
    ops.push(opId);
    const toolMap = new Map<string, ToolDefinition>();
    let augmentedNames: string[] = [];

    augmentFromToolSearch(
      toolSearchResult([DENIED, "write", ALLOWED]),
      opId,
      toolMap,
      (tools) => { augmentedNames = tools.map((t) => t.name); },
      "api",
    );

    // Non-delegated: EVERY discovered tool passes — behavior unchanged.
    for (const name of [DENIED, "write", ALLOWED]) {
      expect(toolMap.has(name)).toBe(true);
      expect(augmentedNames).toContain(name);
    }
    expect(getToolsForOp(opId).map((t) => t.name).sort())
      .toEqual([DENIED, ALLOWED, "write"].sort());
  });
});
