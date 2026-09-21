/**
 * CLASS INVARIANT: a promise a tool's RESULT makes is kept, whether or not
 * the tool was ever in the model's schema.
 *
 * The instance (EXP-7b, qwen3.6:27b, 2026-09-21): `delete_file` was absent
 * from all twelve turns' tool schemas. The model called it five times anyway,
 * dispatch executed all five, and three client originals were gone with no
 * `restore_file` anywhere in the op to undo them — the same three the baseline
 * had recovered.
 *
 * Two things that failure teaches, both pinned here:
 *  - the per-turn schema is ADVISORY, so selection-time closure cannot be the
 *    only place companions are resolved;
 *  - destructive verbs are guessable across harnesses and product-specific
 *    recovery verbs are not, so a size limit silently takes the undo and
 *    leaves the delete.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { ToolDefinition } from "../types.js";

const registered: Array<{ opId: string; names: string[] }> = [];
vi.mock("./runtime.js", () => ({
  registerToolsForOp: (opId: string, tools: Array<{ name: string }>) =>
    registered.push({ opId, names: tools.map(t => t.name) }),
}));

const tool = (name: string): ToolDefinition => ({
  name, description: `${name}`, parameters: { type: "object", properties: {} },
  execute: async () => ({ content: "" }),
});

vi.mock("../tools/registry.js", () => ({
  unifiedRegistry: { get: (n: string) => (n === "restore_file" ? tool("restore_file") : undefined) },
}));
vi.mock("../ops/tools/delegated-toolset.js", () => ({
  isDeniedForDelegatedWorker: (n: string) => n === "restore_file",
}));

const { augmentCompanions } = await import("./tool-augmentation.js");

beforeEach(() => { registered.length = 0; });

describe("a tool that promised an undo brings it when it RUNS", () => {
  it("adds the companion to the executable map and the next turn's schema", () => {
    const toolMap = new Map<string, ToolDefinition>([["delete_file", tool("delete_file")]]);
    augmentCompanions("delete_file", "op_abc123456789", toolMap, undefined, "local");
    expect(toolMap.has("restore_file"), "companion not executable").toBe(true);
    expect(registered.at(-1)?.names, "companion missing from the re-registered schema").toContain("restore_file");
  });

  it("works when the tool that ran was never in the map — the schema is advisory", () => {
    // Exactly the incident: delete_file was in no schema, the model called it
    // from memory, and it executed.
    const toolMap = new Map<string, ToolDefinition>();
    augmentCompanions("delete_file", "op_abc123456789", toolMap, undefined, "local");
    expect(toolMap.has("restore_file")).toBe(true);
  });

  it("is idempotent — a second delete does not re-register", () => {
    const toolMap = new Map<string, ToolDefinition>([["delete_file", tool("delete_file")]]);
    augmentCompanions("delete_file", "op_abc123456789", toolMap, undefined, "local");
    const after = registered.length;
    augmentCompanions("delete_file", "op_abc123456789", toolMap, undefined, "local");
    expect(registered.length).toBe(after);
  });

  it("a tool with no companions changes nothing", () => {
    const toolMap = new Map<string, ToolDefinition>([["read", tool("read")]]);
    augmentCompanions("read", "op_abc123456789", toolMap, undefined, "local");
    expect(registered).toHaveLength(0);
    expect(toolMap.size).toBe(1);
  });

  it("a promise does not widen a deliberately restricted worker", () => {
    const toolMap = new Map<string, ToolDefinition>([["delete_file", tool("delete_file")]]);
    augmentCompanions("delete_file", "op_abc123456789", toolMap, undefined, "delegated");
    expect(toolMap.has("restore_file"), "denylist bypassed by the companion path").toBe(false);
    expect(registered).toHaveLength(0);
  });
});
