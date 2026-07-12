import { describe, it, expect } from "vitest";
import { COMPLETION_GATES, COMPLETION_GATE_ORDER } from "./decide-outcome-gates.js";
import type { Op } from "../../ops/types.js";

const frameworkServe = COMPLETION_GATES.find(g => g.name === "framework-serve")!;

function op(overrides: Partial<Op>): Op {
  return { id: "op-test", type: "chat", task: "t", ...overrides } as unknown as Op;
}

describe("completion gate order", () => {
  it("runs framework-serve LAST — it registers a dev server, so it must fire only on a real terminal (no earlier gate re-opened)", () => {
    expect(COMPLETION_GATE_ORDER.at(-1)).toBe("framework-serve");
    // late-inject's re-check must still precede it (documented ordering).
    expect(COMPLETION_GATE_ORDER.indexOf("late-inject"))
      .toBeLessThan(COMPLETION_GATE_ORDER.indexOf("framework-serve"));
  });
});

describe("framework-serve gate", () => {
  it("is inert on non-app_build ops (the hot path — every chat turn)", async () => {
    const out = await frameworkServe.evaluate({ op: op({ type: "chat", appUrl: undefined }), turnIdx: 1, toolCalls: [] });
    expect(out.reopen).toBe(false);
  });

  it("is inert on an app_build op with no appUrl", async () => {
    const out = await frameworkServe.evaluate({ op: op({ type: "app_build", appUrl: undefined }), turnIdx: 1, toolCalls: [] });
    expect(out.reopen).toBe(false);
  });

  it("never re-opens, and no-ops without throwing when the app dir has no framework project", async () => {
    // Exercises the real parse → workspacePath → finalizeFrameworkBuild path:
    // a non-existent/non-framework dir resolves to {handled:false} (static), so
    // registration is skipped. Proves the wiring and the CONTINUE contract.
    const out = await frameworkServe.evaluate({
      op: op({ type: "app_build", appUrl: "http://127.0.0.1:7007/apps/no-such-app-xyz/index.html" }),
      turnIdx: 1,
      toolCalls: [],
    });
    expect(out.reopen).toBe(false);
  });
});
