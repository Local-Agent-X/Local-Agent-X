import { afterEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  getToolDispatcher,
  getToolsForOp,
  resetCanonicalRuntime,
  resolveAdapterFactory,
  type ToolDispatcher,
} from "../canonical-loop/index.js";
import type { AdapterReport, ToolCall } from "../canonical-loop/adapter-contract.js";
import type { AppBuildRuntimeDescriptor, Op } from "../ops/types.js";
import { clearSessionWorkRoot, sessionWorkRootOf } from "../workspace/paths.js";
import { ORCHESTRATOR_STATE_FILENAME } from "../auto-build/orchestrator/state.js";
import {
  guardAppBuildDispatcher,
  ProductBuildOwnershipChangedError,
  registerAppBuildRuntime,
  restorePersistedAppBuildRuntimes,
} from "./build-app-runtime.js";

const descriptor: AppBuildRuntimeDescriptor = {
  kind: "app-build",
  strategy: "in-canonical-sub-agent",
  provider: "test-provider",
  appName: "resumable-app",
  appDir: "C:\\workspace\\apps\\resumable-app",
  appUrl: "/apps/resumable-app/",
  prompt: "Build it",
  brief: "Build it",
  systemPrompt: "You build apps.",
  tier: "full-stack",
};

function op(
  id: string,
  state: "paused" | "cancelled",
  runtimeDescriptor: AppBuildRuntimeDescriptor = descriptor,
): Op {
  return {
    id,
    type: "app_build",
    task: "Build app",
    contextPack: {} as Op["contextPack"],
    lane: "build",
    retryPolicy: { maxRecoveryAttempts: 2, backoffMs: [] },
    runtimeDescriptor,
    ownerId: "local-user",
    visibility: "private",
    status: state === "paused" ? "paused" : "cancelled",
    createdAt: new Date().toISOString(),
    attemptCount: 0,
    canonical: { state },
  };
}

function call(tool: string, toolCallId = `call-${tool}`): ToolCall {
  return { toolCallId, tool, args: {} };
}

function successfulDispatcher(onDispatch?: (call: ToolCall) => void): ToolDispatcher {
  return {
    async dispatch(toolCall) {
      onDispatch?.(toolCall);
      return {
        toolCallId: toolCall.toolCallId,
        status: "ok",
        result: { ok: true },
        durationMs: 0,
      };
    },
  };
}

const workRootIds = new Set(["paused-build", "cancelled-build"]);

afterEach(() => {
  resetCanonicalRuntime();
  for (const id of workRootIds) clearSessionWorkRoot(id);
  workRootIds.clear();
  workRootIds.add("paused-build");
  workRootIds.add("cancelled-build");
});

describe("restorePersistedAppBuildRuntimes", () => {
  it("reconstructs tools, adapter, and work root for a resumable build only", () => {
    const paused = op("paused-build", "paused");
    const cancelled = op("cancelled-build", "cancelled");

    expect(restorePersistedAppBuildRuntimes([paused, cancelled])).toEqual(["paused-build"]);
    expect(getToolsForOp(paused.id).map((tool) => tool.name)).toEqual(expect.arrayContaining([
      "read",
      "write",
      "bash",
      "process_start",
      "app_serve_frontend",
    ]));
    expect(resolveAdapterFactory(paused)).toBeTypeOf("function");
    expect(sessionWorkRootOf(paused.id)).toBe(descriptor.appDir);

    expect(getToolsForOp(cancelled.id)).toEqual([]);
    expect(sessionWorkRootOf(cancelled.id)).toBeUndefined();
  });

  it("rechecks ownership when a queued Quick Build adapter starts", async () => {
    const appDir = mkdtempSync(join(tmpdir(), "lax-build-runtime-race-"));
    const id = "queued-before-product-build";
    workRootIds.add(id);
    const runtimeDescriptor = { ...descriptor, appName: "race-app", appDir };
    const queued = op(id, "paused", runtimeDescriptor);
    try {
      expect(registerAppBuildRuntime(queued, runtimeDescriptor)).toEqual({ registered: true });
      expect(getToolsForOp(id).map((tool) => tool.name)).toContain("write");

      mkdirSync(join(appDir, "spec"), { recursive: true });
      writeFileSync(join(appDir, "spec", "plan.md"), "# Product plan\n", "utf-8");

      const adapter = await resolveAdapterFactory(queued)!();
      const reports: AdapterReport[] = [];
      const result = await adapter.runTurn({
        opId: id,
        turnIdx: 0,
        messages: [],
        tools: getToolsForOp(id),
      }, (report) => reports.push(report));

      expect(adapter.name).toBe("app-build-product-owned");
      expect(result.terminalReason).toBe("error");
      expect(reports).toContainEqual(expect.objectContaining({
        kind: "error",
        code: "product_build_owns_project",
      }));
      expect(getToolsForOp(id)).toEqual([]);
      expect(sessionWorkRootOf(id)).toBeUndefined();
    } finally {
      rmSync(appDir, { recursive: true, force: true });
    }
  });

  it("restores a Product Build-owned Quick Build as a no-tool terminal adapter", async () => {
    const appDir = mkdtempSync(join(tmpdir(), "lax-build-runtime-restore-"));
    const id = "restored-after-product-build";
    workRootIds.add(id);
    const runtimeDescriptor = { ...descriptor, appName: "restore-app", appDir };
    const paused = op(id, "paused", runtimeDescriptor);
    try {
      mkdirSync(join(appDir, "spec"), { recursive: true });
      writeFileSync(join(appDir, "spec", "plan.md"), "# Product plan\n", "utf-8");

      expect(restorePersistedAppBuildRuntimes([paused])).toEqual([]);
      expect(getToolsForOp(id)).toEqual([]);
      expect(sessionWorkRootOf(id)).toBeUndefined();

      const adapter = await resolveAdapterFactory(paused)!();
      expect(adapter.name).toBe("app-build-product-owned");
    } finally {
      rmSync(appDir, { recursive: true, force: true });
    }
  });

  it("malformed state restores blocked with stale-marker cleanup guidance", async () => {
    const appDir = mkdtempSync(join(tmpdir(), "lax-build-runtime-stale-"));
    const id = "restored-with-stale-state";
    workRootIds.add(id);
    const runtimeDescriptor = { ...descriptor, appName: "stale-app", appDir };
    const paused = op(id, "paused", runtimeDescriptor);
    try {
      writeFileSync(join(appDir, ORCHESTRATOR_STATE_FILENAME), "{}", "utf-8");

      expect(restorePersistedAppBuildRuntimes([paused])).toEqual([]);
      const adapter = await resolveAdapterFactory(paused)!();
      const reports: AdapterReport[] = [];
      await adapter.runTurn({
        opId: id,
        turnIdx: 0,
        messages: [],
        tools: [],
      }, (report) => reports.push(report));

      expect(reports).toContainEqual(expect.objectContaining({
        kind: "error",
        message: expect.stringContaining("delete that stale marker"),
      }));
      expect(getToolsForOp(id)).toEqual([]);
    } finally {
      rmSync(appDir, { recursive: true, force: true });
    }
  });

  it("keeps normal Quick Build mutations on the canonical dispatcher", async () => {
    const appDir = mkdtempSync(join(tmpdir(), "lax-build-dispatch-normal-"));
    const dispatched: string[] = [];
    try {
      const guarded = guardAppBuildDispatcher(
        successfulDispatcher((toolCall) => dispatched.push(toolCall.tool)),
        { appName: "normal-app", appDir },
      );

      await expect(guarded.dispatch(call("write"))).resolves.toMatchObject({ status: "ok" });
      expect(dispatched).toEqual(["write"]);
    } finally {
      rmSync(appDir, { recursive: true, force: true });
    }
  });

  it("blocks mutation when ownership appears after adapter construction", async () => {
    const appDir = mkdtempSync(join(tmpdir(), "lax-build-dispatch-adapter-race-"));
    const id = "ownership-after-adapter-construction";
    workRootIds.add(id);
    const runtimeDescriptor = { ...descriptor, appName: "adapter-race-app", appDir };
    const paused = op(id, "paused", runtimeDescriptor);
    try {
      expect(registerAppBuildRuntime(paused, runtimeDescriptor)).toEqual({ registered: true });
      const adapter = await resolveAdapterFactory(paused)!();
      expect(adapter.name).not.toBe("app-build-product-owned");

      mkdirSync(join(appDir, "spec"), { recursive: true });
      writeFileSync(join(appDir, "spec", "plan.md"), "# Product plan\n", "utf-8");

      await expect(getToolDispatcher(id).dispatch(call("write"))).rejects.toBeInstanceOf(
        ProductBuildOwnershipChangedError,
      );
      expect(getToolsForOp(id)).toEqual([]);
      expect(sessionWorkRootOf(id)).toBeUndefined();
    } finally {
      rmSync(appDir, { recursive: true, force: true });
    }
  });

  it("rechecks each mixed-batch call and blocks a mid-turn mutation", async () => {
    const appDir = mkdtempSync(join(tmpdir(), "lax-build-dispatch-mid-turn-"));
    const dispatched: string[] = [];
    try {
      const delegate = successfulDispatcher((toolCall) => {
        dispatched.push(toolCall.tool);
        if (toolCall.tool === "read") {
          mkdirSync(join(appDir, "spec"), { recursive: true });
          writeFileSync(join(appDir, "spec", "plan.md"), "# Product plan\n", "utf-8");
        }
      });
      delegate.dispatchBatch = async () => {
        throw new Error("guard must serialize a batch containing mutations");
      };
      const guarded = guardAppBuildDispatcher(delegate, { appName: "mid-turn-app", appDir });

      await expect(guarded.dispatchBatch!([
        call("read", "call-read"),
        call("bash", "call-bash"),
      ])).rejects.toMatchObject({
        name: "ProductBuildOwnershipChangedError",
        message: expect.stringContaining("Quick Build mutation \"bash\" blocked"),
      });
      expect(dispatched).toEqual(["read"]);
    } finally {
      rmSync(appDir, { recursive: true, force: true });
    }
  });

  it("blocks mutation after a restored adapter has already been constructed", async () => {
    const appDir = mkdtempSync(join(tmpdir(), "lax-build-dispatch-restored-race-"));
    const id = "ownership-after-restored-adapter";
    workRootIds.add(id);
    const runtimeDescriptor = { ...descriptor, appName: "restored-race-app", appDir };
    const paused = op(id, "paused", runtimeDescriptor);
    try {
      expect(restorePersistedAppBuildRuntimes([paused])).toEqual([id]);
      const adapter = await resolveAdapterFactory(paused)!();
      expect(adapter.name).not.toBe("app-build-product-owned");

      mkdirSync(join(appDir, "spec"), { recursive: true });
      writeFileSync(join(appDir, "spec", "plan.md"), "# Product plan\n", "utf-8");

      await expect(getToolDispatcher(id).dispatch(call("connector_create"))).rejects.toMatchObject({
        name: "ProductBuildOwnershipChangedError",
        message: expect.stringContaining("Product Build now owns this project"),
      });
      expect(getToolsForOp(id)).toEqual([]);
    } finally {
      rmSync(appDir, { recursive: true, force: true });
    }
  });
});
