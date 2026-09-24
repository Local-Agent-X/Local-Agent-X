/**
 * One admission path for both ways an op's tool set widens mid-flight: a
 * tool_search hit, and (EXP-20) a call by name to a tool the schema does not
 * carry. Presence is the op's schema set; the delegated denylist holds either
 * way; an unknown name loads nothing and leaves the call to the ordinary
 * unknown-tool corrective.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ToolDefinition } from "../types.js";
import { unifiedRegistry } from "../tools/registry.js";
import { augmentByName, augmentFromToolSearch } from "./tool-augmentation.js";

function tool(name: string): ToolDefinition {
  return { name, description: `${name} does a thing.`, parameters: { type: "object", properties: {} }, execute: async () => ({ content: "" }) } as unknown as ToolDefinition;
}

let seq = 0;
const opId = () => `op_augment_test_${seq++}`;

beforeEach(() => {
  unifiedRegistry._resetForTesting();
  for (const n of ["read", "grep", "delete_file", "restore_file", "write", "op_submit_async"]) unifiedRegistry.register(tool(n));
});
afterEach(() => unifiedRegistry._resetForTesting());

describe("augmentByName — a call to a tool the schema does not carry", () => {
  it("loads a registered tool into the executable map and re-registers the op's schema, once", () => {
    const toolMap = new Map([["read", tool("read")]]);
    const registered: ToolDefinition[][] = [];
    const id = opId();
    expect(augmentByName("delete_file", id, toolMap, (t) => registered.push(t))).toBe(true);
    expect([...toolMap.keys()]).toEqual(["read", "delete_file"]);
    expect(registered).toHaveLength(1);
    expect(registered[0].map((t) => t.name)).toEqual(["read", "delete_file"]);
    // Already present: nothing to do, nothing re-registered.
    expect(augmentByName("delete_file", id, toolMap, (t) => registered.push(t))).toBe(false);
    expect(registered).toHaveLength(1);
  });

  it("an unknown name loads nothing — the unknown-tool corrective stays the answer for it", () => {
    const toolMap = new Map([["read", tool("read")]]);
    expect(augmentByName("delet_file", opId(), toolMap)).toBe(false);
    expect(augmentByName("", opId(), toolMap)).toBe(false);
    expect([...toolMap.keys()]).toEqual(["read"]);
  });

  it("a delegated worker cannot name its way to a denied tool, and can still name an allowed one", () => {
    const toolMap = new Map([["read", tool("read")]]);
    // Denied for delegated workers: orchestration, and every worktree-required
    // write — restore_file included, it re-materializes bytes on disk.
    for (const denied of ["op_submit_async", "write", "delete_file", "restore_file"]) {
      expect(augmentByName(denied, opId(), toolMap, undefined, "delegated"), denied).toBe(false);
    }
    expect([...toolMap.keys()]).toEqual(["read"]);
    // A read-only tool is fine.
    expect(augmentByName("grep", opId(), toolMap, undefined, "delegated")).toBe(true);
    expect([...toolMap.keys()]).toEqual(["read", "grep"]);
  });
});

describe("augmentFromToolSearch keeps its shape on the shared path", () => {
  it("parses the search output, skips present and unknown names, registers the union", () => {
    const toolMap = new Map([["read", tool("read")]]);
    const registered: ToolDefinition[][] = [];
    augmentFromToolSearch(JSON.stringify([{ name: "delete_file" }, { name: "read" }, { name: "nope" }, { bogus: 1 }]), opId(), toolMap, (t) => registered.push(t));
    expect([...toolMap.keys()]).toEqual(["read", "delete_file"]);
    expect(registered[0].map((t) => t.name)).toEqual(["read", "delete_file"]);
    augmentFromToolSearch("No tools matched the query.", opId(), toolMap, (t) => registered.push(t));
    expect(registered).toHaveLength(1);
  });
});
