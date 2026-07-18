import { afterEach, describe, expect, it } from "vitest";
import {
  getToolsForOp,
  resetCanonicalRuntime,
  resolveAdapterFactory,
} from "../canonical-loop/index.js";
import type { AppBuildRuntimeDescriptor, Op } from "../ops/types.js";
import { clearSessionWorkRoot, sessionWorkRootOf } from "../workspace/paths.js";
import { restorePersistedAppBuildRuntimes } from "./build-app-runtime.js";

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

function op(id: string, state: "paused" | "cancelled"): Op {
  return {
    id,
    type: "app_build",
    task: "Build app",
    contextPack: {} as Op["contextPack"],
    lane: "build",
    retryPolicy: { maxRecoveryAttempts: 2, backoffMs: [] },
    runtimeDescriptor: descriptor,
    ownerId: "local-user",
    visibility: "private",
    status: state === "paused" ? "paused" : "cancelled",
    createdAt: new Date().toISOString(),
    attemptCount: 0,
    canonical: { state },
  };
}

afterEach(() => {
  resetCanonicalRuntime();
  clearSessionWorkRoot("paused-build");
  clearSessionWorkRoot("cancelled-build");
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
});
