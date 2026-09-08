import { describe, it, expect, vi, beforeEach } from "vitest";

// Partial mock: keep the real touched-app-files detection so the gate's own
// trigger path runs, but capture what it hands the render-verify probe.
vi.mock("./render-verify.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./render-verify.js")>();
  return {
    ...actual,
    runRenderVerifyGate: vi.fn(async () => ({ nudge: "", retryCount: 0, shouldRetry: false, capReached: false })),
  };
});

import { COMPLETION_GATES, COMPLETION_GATE_ORDER } from "./decide-outcome-gates.js";
import { runRenderVerifyGate } from "./render-verify.js";
import { expandSlashCommand } from "../../slash-commands.js";
import type { Op } from "../../ops/types.js";
import type { ToolCall } from "../contract-types.js";

const frameworkServe = COMPLETION_GATES.find(g => g.name === "framework-serve")!;
const renderVerify = COMPLETION_GATES.find(g => g.name === "render-verify")!;
const mockRenderVerify = vi.mocked(runRenderVerifyGate);

function op(overrides: Partial<Op>): Op {
  return { id: "op-test", type: "chat", task: "t", ...overrides } as unknown as Op;
}

/** A turn that wrote an app file — the render-verify gate's trigger. */
const APP_WRITE: ToolCall[] = [{ toolCallId: "t1", tool: "write", args: { path: "workspace/apps/todo/index.html" } }];

beforeEach(() => { mockRenderVerify.mockClear(); });

describe("render-verify gate — appDescription is the user's ask, not the slash template", () => {
  const EXPANDED = expandSlashCommand("/app-build a todo app with dark mode")!.agentMessage;

  it("premise: on the chat path op.task is the EXPANDED message", () => {
    expect(EXPANDED).toContain("**SLASH COMMAND**");
    expect(EXPANDED).toContain("# /app-build methodology");
    expect(EXPANDED.length).toBeGreaterThan(1000);
  });

  it("hands the screenshot judge `/app-build a todo app with dark mode`, never the SKILL.md body", async () => {
    const out = await renderVerify.evaluate({
      op: op({ id: "op-slash", type: "app_build", task: EXPANDED, appUrl: "http://127.0.0.1:7007/apps/todo/index.html" }),
      turnIdx: 1,
      toolCalls: APP_WRITE,
      assistantText: "",
    });
    expect(out.reopen).toBe(false);
    expect(mockRenderVerify).toHaveBeenCalledTimes(1);
    expect(mockRenderVerify).toHaveBeenCalledWith("op-slash", {
      appUrl: "http://127.0.0.1:7007/apps/todo/index.html",
      appDescription: "/app-build a todo app with dark mode",
    });
  });

  it("a plain (non-slash) task reaches the judge byte-identical", async () => {
    await renderVerify.evaluate({
      op: op({ id: "op-plain", type: "app_build", task: "a todo app with dark mode", appUrl: "http://x/apps/todo/index.html" }),
      turnIdx: 1,
      toolCalls: APP_WRITE,
      assistantText: "",
    });
    expect(mockRenderVerify.mock.calls[0][1]?.appDescription).toBe("a todo app with dark mode");
  });

  it("does not run at all when the turn touched no app files (trigger unchanged)", async () => {
    const out = await renderVerify.evaluate({ op: op({ task: EXPANDED }), turnIdx: 1, toolCalls: [], assistantText: "" });
    expect(out.reopen).toBe(false);
    expect(mockRenderVerify).not.toHaveBeenCalled();
  });
});

describe("completion gate context", () => {
  it("carries the turn's final assistant text — a gate may judge what the model SAID; existing gates ignore it", async () => {
    // Pinned via the type: a context WITH assistantText is what CompletionGate
    // accepts. The existing gates' trigger paths are untouched by the field.
    const out = await renderVerify.evaluate({
      op: op({ task: "t" }), turnIdx: 1, toolCalls: [], assistantText: "All done, the app is live.",
    });
    expect(out.reopen).toBe(false);
    expect(mockRenderVerify).not.toHaveBeenCalled();
  });
});

describe("completion gate order", () => {
  it("runs framework-serve LAST — it registers a dev server, so it must fire only on a real terminal (no earlier gate re-opened)", () => {
    expect(COMPLETION_GATE_ORDER.at(-1)).toBe("framework-serve");
    // late-inject's re-check must still precede it (documented ordering).
    expect(COMPLETION_GATE_ORDER.indexOf("late-inject"))
      .toBeLessThan(COMPLETION_GATE_ORDER.indexOf("framework-serve"));
  });

  it("runs unresolved-tool-intent BEFORE earned-done — a leaked call is reissued, not pushed toward open steps", () => {
    expect(COMPLETION_GATE_ORDER).toEqual([
      "render-verify",
      "build-verify",
      "spec-probe",
      "spec-audit",
      "design-verify",
      "unresolved-tool-intent",
      "earned-done",
      "late-inject",
      "framework-serve",
    ]);
  });
});

describe("framework-serve gate", () => {
  it("is inert on non-app_build ops (the hot path — every chat turn)", async () => {
    const out = await frameworkServe.evaluate({ op: op({ type: "chat", appUrl: undefined }), turnIdx: 1, toolCalls: [], assistantText: "" });
    expect(out.reopen).toBe(false);
  });

  it("is inert on an app_build op with no appUrl", async () => {
    const out = await frameworkServe.evaluate({ op: op({ type: "app_build", appUrl: undefined }), turnIdx: 1, toolCalls: [], assistantText: "" });
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
      assistantText: "",
    });
    expect(out.reopen).toBe(false);
  });
});
