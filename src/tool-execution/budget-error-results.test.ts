import { describe, it, expect } from "vitest";
import { applyBudget } from "./audit-tool-call.js";
import type { ToolCallContext } from "./context.js";
import type { ToolResult } from "../types.js";

// Regression for TD-8: error results used to bypass the output budget entirely
// (applyBudget only ran when !result.isError). A failing build's multi-MB
// stderr then landed in the model window uncut. These assert that oversized
// content is truncated regardless of the isError flag, while the error envelope
// is preserved.

const OVERSIZED = "x".repeat(60_000); // > DEFAULT_MAX_RESULT_SIZE (50_000)

function ctxWith(result: ToolResult): ToolCallContext {
  return { result } as unknown as ToolCallContext;
}

describe("applyBudget — TD-8 error results are budgeted too", () => {
  it("truncates an oversized ERROR result and keeps the error envelope", () => {
    const ctx = ctxWith({
      content: OVERSIZED,
      isError: true,
      status: "error",
      metadata: { layer: "tool" },
    });
    applyBudget(ctx);
    const out = ctx.result!;
    expect(out.content.length).toBeLessThan(OVERSIZED.length);
    expect(out.content).toMatch(/truncated/);
    // envelope preserved
    expect(out.isError).toBe(true);
    expect(out.status).toBe("error");
    expect(out.metadata).toEqual({ layer: "tool" });
  });

  it("still truncates oversized success results (unchanged behavior)", () => {
    const ctx = ctxWith({ content: OVERSIZED });
    applyBudget(ctx);
    expect(ctx.result!.content.length).toBeLessThan(OVERSIZED.length);
    expect(ctx.result!.content).toMatch(/truncated/);
  });

  it("leaves small error results untouched", () => {
    const ctx = ctxWith({ content: "boom", isError: true });
    applyBudget(ctx);
    expect(ctx.result!.content).toBe("boom");
  });
});
