import { describe, it, expect, beforeEach } from "vitest";
import {
  appIdsTouchedByTurn,
  registerOpAppTouch,
  listOpsForApp,
  clearRenderVerifyStateForOp,
  peekPreviewRuntimeErrorCount,
  pushPreviewRuntimeError,
  runRenderVerifyGate,
  setRenderProbe,
  _resetRenderVerifyState,
} from "./render-verify.js";
import { handleAppRuntimeError } from "../../chat-ws/ide-runtime-error.js";
import type { ToolCall } from "../contract-types.js";

const call = (tool: string, path?: string): ToolCall =>
  ({ tool, args: path ? { path } : {} }) as unknown as ToolCall;

beforeEach(() => _resetRenderVerifyState());

describe("appIdsTouchedByTurn", () => {
  it("extracts the app id from write/edit paths", () => {
    expect(appIdsTouchedByTurn([
      call("write", "/x/workspace/apps/todo-list/index.html"),
      call("edit", "workspace/apps/todo-list/app.js"),
      call("edit", "C:\\ws\\workspace\\apps\\timer\\main.js"),
    ])).toEqual(["todo-list", "timer"]);
  });

  it("ignores non-app paths, read tools, and pathless build_app", () => {
    expect(appIdsTouchedByTurn([
      call("write", "/x/src/main.ts"),
      call("read", "/x/workspace/apps/todo-list/index.html"),
      call("build_app"),
    ])).toEqual([]);
  });
});

describe("app→op registry", () => {
  it("routes and clears per op", () => {
    registerOpAppTouch("op1", "todo-list");
    registerOpAppTouch("op2", "todo-list");
    expect(listOpsForApp("todo-list").sort()).toEqual(["op1", "op2"]);
    clearRenderVerifyStateForOp("op1");
    expect(listOpsForApp("todo-list")).toEqual(["op2"]);
    clearRenderVerifyStateForOp("op2");
    expect(listOpsForApp("todo-list")).toEqual([]);
  });
});

// Cross-seam contract: the phone ingress must land errors in the SAME buffer
// the render-verify gate drains — no parallel pipe.
describe("handleAppRuntimeError", () => {
  it("buffers a phone-reported error against every live op that touched the app", async () => {
    registerOpAppTouch("op1", "todo-list");
    await handleAppRuntimeError("todo-list", { kind: "blank", message: "Preview rendered no visible content" });
    expect(peekPreviewRuntimeErrorCount("op1")).toBe(1);
  });

  it("drops errors for an app no live op touched, and empty messages", async () => {
    await handleAppRuntimeError("unknown-app", { kind: "error", message: "boom" });
    registerOpAppTouch("op1", "todo-list");
    await handleAppRuntimeError("todo-list", { kind: "error" });
    expect(peekPreviewRuntimeErrorCount("op1")).toBe(0);
  });
});

// Headless probe fallback: when no OPEN preview reported errors, the gate can
// actively load the app and use whatever the probe observes. totalMs:0 skips
// the buffer wait; opts.probe injects a fake so no real window/model is used.
describe("runRenderVerifyGate — headless probe fallback", () => {
  const err = (message: string) => ({ kind: "console", message, ts: 1 });

  it("probes when the buffer is empty and routes probe errors through the retry logic", async () => {
    const gate = await runRenderVerifyGate("op-probe", {
      totalMs: 0,
      appUrl: "http://127.0.0.1:7007/apps/x/index.html",
      appDescription: "a todo app",
      probe: async () => [err("Uncaught ReferenceError: foo is not defined")],
    });
    expect(gate.shouldRetry).toBe(true);
    expect(gate.nudge).toContain("foo is not defined");
  });

  it("does NOT probe when an open preview already reported errors", async () => {
    pushPreviewRuntimeError("op-open", { kind: "error", message: "from the iframe", ts: 1 });
    let probed = false;
    const gate = await runRenderVerifyGate("op-open", {
      totalMs: 0,
      appUrl: "http://127.0.0.1:7007/apps/x/index.html",
      probe: async () => { probed = true; return [err("should not be used")]; },
    });
    expect(probed).toBe(false);
    expect(gate.nudge).toContain("from the iframe");
  });

  it("no appUrl → probe not called, gate passes (identical to pre-probe behavior)", async () => {
    let probed = false;
    const gate = await runRenderVerifyGate("op-nourl", {
      totalMs: 0,
      probe: async () => { probed = true; return [err("x")]; },
    });
    expect(probed).toBe(false);
    expect(gate.shouldRetry).toBe(false);
  });

  it("probe returning null (headless server) → gate passes", async () => {
    const gate = await runRenderVerifyGate("op-null", {
      totalMs: 0, appUrl: "http://localhost:4173/", probe: async () => null,
    });
    expect(gate.shouldRetry).toBe(false);
  });

  it("probe returning [] (clean load) → gate passes", async () => {
    const gate = await runRenderVerifyGate("op-clean", {
      totalMs: 0, appUrl: "http://localhost:4173/", probe: async () => [],
    });
    expect(gate.shouldRetry).toBe(false);
  });

  it("a throwing probe is treated as no evidence, not a crash", async () => {
    const gate = await runRenderVerifyGate("op-throw", {
      totalMs: 0, appUrl: "http://localhost:4173/",
      probe: async () => { throw new Error("bridge died"); },
    });
    expect(gate.shouldRetry).toBe(false);
  });

  it("with no probe registered, the gate is a pure buffer check", async () => {
    setRenderProbe(null);
    const gate = await runRenderVerifyGate("op-noprobe", {
      totalMs: 0, appUrl: "http://localhost:4173/",
    });
    expect(gate.shouldRetry).toBe(false);
  });
});
