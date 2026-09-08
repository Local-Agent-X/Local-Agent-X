import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ToolCallContext } from "./context.js";
import type { ToolDefinition, ToolResult } from "../types.js";
import type { ContextWindowResolution } from "../context-manager/model-windows.js";

// applyBudget sizes each tool result against the TARGET WINDOW. The model is
// reached through the op the call belongs to (ctx.operationId -> op-store ->
// resolveOpModel), and the window through resolveContextWindow. Regression
// for 2026-09-08: a 65,536-token local model got the flat 50k-char cap and
// two results overflowed the window inside a single step.

const windows = new Map<string, ContextWindowResolution>();
const opModels = new Map<string, string | undefined>();

vi.mock("../context-manager/model-windows.js", () => ({
  resolveContextWindow: (model: string): ContextWindowResolution =>
    windows.get(model) ?? { tokens: 128_000, provenance: "heuristic" },
}));
vi.mock("../ops/op-store.js", () => ({
  readOp: (opId: string) => (opModels.has(opId) ? { id: opId, model: opModels.get(opId) } : null),
}));
vi.mock("../canonical-loop/op-model.js", () => ({
  resolveOpModel: (op: { model?: string }) => op.model,
}));

const { applyBudget } = await import("./audit-tool-call.js");

const FORTY_K = "y".repeat(40_000); // under the 50k default, over the 65k-window cap
const SIXTY_K = "z".repeat(60_000); // over the default

function tool(name: string): ToolDefinition {
  return {
    name,
    description: `${name} tool for the cap test`,
    parameters: { type: "object", properties: { q: { type: "string" } } },
    execute: async () => ({ content: "" }),
  };
}

function ctxWith(result: ToolResult, operationId?: string, tools: ToolDefinition[] = []): ToolCallContext {
  return {
    result,
    operationId,
    toolMap: new Map(tools.map(t => [t.name, t])),
  } as unknown as ToolCallContext;
}

beforeEach(() => {
  windows.clear();
  opModels.clear();
});

describe("applyBudget — the cap follows the op's model window", () => {
  it("a probed 65,536-token local model truncates a 40k-char result", () => {
    opModels.set("op-local", "qwen3.6:27b");
    windows.set("qwen3.6:27b", { tokens: 65_536, provenance: "probed" });
    const ctx = ctxWith({ content: FORTY_K }, "op-local");
    applyBudget(ctx);
    const out = ctx.result!.content;
    expect(out.length).toBeLessThan(FORTY_K.length);
    expect(out).toMatch(/truncated/);
    // Spill-to-disk + preview behavior is unchanged: the note names the file.
    expect(out).toMatch(/full result \(40000 chars\) saved to/);
  });

  it("a cloud model (200k, exact) leaves the same 40k-char result intact", () => {
    opModels.set("op-cloud", "claude-sonnet-4-6");
    windows.set("claude-sonnet-4-6", { tokens: 200_000, provenance: "exact" });
    const ctx = ctxWith({ content: FORTY_K }, "op-cloud");
    applyBudget(ctx);
    expect(ctx.result!.content).toBe(FORTY_K);
  });

  it("a 'floor' window is a placeholder, not a measurement: the default cap stays", () => {
    opModels.set("op-unloaded", "gemma4:9b");
    windows.set("gemma4:9b", { tokens: 8_192, provenance: "floor" });
    const ctx = ctxWith({ content: FORTY_K }, "op-unloaded");
    applyBudget(ctx);
    expect(ctx.result!.content).toBe(FORTY_K);
    // ...and the default still applies above 50k.
    const big = ctxWith({ content: SIXTY_K }, "op-unloaded");
    applyBudget(big);
    expect(big.result!.content).toMatch(/truncated/);
  });

  it("the measured manifest tightens the cap: a heavier tool set leaves less room per result", () => {
    opModels.set("op-tools", "qwen3.6:27b");
    windows.set("qwen3.6:27b", { tokens: 65_536, provenance: "probed" });
    const heavy = Array.from({ length: 80 }, (_, i) => ({
      ...tool(`tool_${i}`),
      description: "d".repeat(600),
    }));
    const bare = ctxWith({ content: FORTY_K }, "op-tools");
    const loaded = ctxWith({ content: FORTY_K }, "op-tools", heavy);
    applyBudget(bare);
    applyBudget(loaded);
    expect(loaded.result!.content.length).toBeLessThan(bare.result!.content.length);
  });

  it("no op (MCP bridge / ari-kernel / bare dispatch) keeps the default cap", () => {
    const ctx = ctxWith({ content: FORTY_K });
    applyBudget(ctx);
    expect(ctx.result!.content).toBe(FORTY_K);
  });

  it("an op whose model cannot be resolved keeps the default cap", () => {
    opModels.set("op-nomodel", undefined);
    const ctx = ctxWith({ content: FORTY_K }, "op-nomodel");
    applyBudget(ctx);
    expect(ctx.result!.content).toBe(FORTY_K);
  });

  it("preserves the error envelope while capping against the window", () => {
    opModels.set("op-err", "qwen3.6:27b");
    windows.set("qwen3.6:27b", { tokens: 65_536, provenance: "probed" });
    const ctx = ctxWith({ content: FORTY_K, isError: true, status: "error", metadata: { layer: "tool" } }, "op-err");
    applyBudget(ctx);
    expect(ctx.result!.isError).toBe(true);
    expect(ctx.result!.status).toBe("error");
    expect(ctx.result!.metadata).toEqual({ layer: "tool" });
    expect(ctx.result!.content).toMatch(/truncated/);
  });
});
