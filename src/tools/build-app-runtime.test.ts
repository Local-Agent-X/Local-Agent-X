import { afterEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  getToolsForOp,
  resetCanonicalRuntime,
  resolveAdapterFactory,
} from "../canonical-loop/index.js";
import type { AdapterReport } from "../canonical-loop/adapter-contract.js";
import type { AppBuildRuntimeDescriptor, Op } from "../ops/types.js";
import { clearSessionWorkRoot, sessionWorkRootOf } from "../workspace/paths.js";
import { ORCHESTRATOR_STATE_FILENAME } from "../auto-build/orchestrator/state.js";
import { registerAppBuildRuntime, restorePersistedAppBuildRuntimes } from "./build-app-runtime.js";

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
});
