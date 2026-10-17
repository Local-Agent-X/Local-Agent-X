import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  getToolDispatcher,
  getToolsForOp,
  resetCanonicalRuntime,
  resolveAdapterFactory,
  type ToolDispatcher,
} from "../canonical-loop/index.js";
import type { AdapterReport, ToolCall } from "../canonical-loop/public/build-adapters.js";
import type { AppBuildRuntimeDescriptor, Op } from "../ops/types.js";
import { clearSessionWorkRoot, sessionWorkRootOf } from "../workspace/paths.js";
import { ORCHESTRATOR_STATE_FILENAME } from "../auto-build/orchestrator/state.js";
import {
  builderToolsForTier,
  guardAppBuildDispatcher,
  ProductBuildOwnershipChangedError,
  registerAppBuildRuntime,
  restorePersistedAppBuildRuntimes,
} from "./build-app-runtime.js";
import { resetDesignDeliveries } from "./app-tools/design-gate.js";
import { UNNAMED_DELETE_USE_TRASH_TEXT } from "../tool-execution/unnamed-delete-gate.js";
import { setAriRequired } from "../ari-kernel/state.js";

// A temp app dir, NOT resolve("workspace", …): the repo-root `workspace` is a
// SYMLINK into Documents on any dev box where the dev server has run
// (loadConfig's intended behavior), so a cwd-anchored appDir canonicalizes to
// a different spelling than the fixture compares against. TMPDIR is already
// canonical (shared vitest setup), so this path round-trips realpath cleanly.
const scratchRoot = mkdtempSync(join(tmpdir(), "build-app-runtime-"));

const descriptor: AppBuildRuntimeDescriptor = {
  kind: "app-build",
  strategy: "in-canonical-sub-agent",
  provider: "test-provider",
  appName: "resumable-app",
  appDir: resolve(scratchRoot, "apps", "resumable-app"),
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

afterAll(() => {
  rmSync(scratchRoot, { recursive: true, force: true });
});

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

// Live 2026-10-16: a builder's `rm` of the scaffold's starter files was refused
// with "Delete them with delete_file instead", a tool the builder did not have,
// so it reported "deleting files is blocked" and left them behind. A refusal
// must name a route the refused agent can take.
describe("the builder has the tool the shell-delete refusal names", () => {
  it.each(["quick-html", "full-stack", "frontend-spa", "compiled-native"] as const)("%s", (tier) => {
    const named = [...UNNAMED_DELETE_USE_TRASH_TEXT.matchAll(/\b(delete_file)\b/g)].map((m) => m[1]);
    expect(named.length).toBeGreaterThan(0);
    const tools = builderToolsForTier(tier).map((t) => t.name);
    for (const name of named) expect(tools).toContain(name);
  });
});

// Live 2026-10-16: the builder's first index.html was refused by the design
// gate ("the house design system had not been loaded") although its prompt
// carries the system. build_app recorded the delivery under the CHAT's session,
// but the builder's tools run as op.id. This sends a real write through the
// dispatcher the runtime registers, so the key and the stamp must agree.
describe("the builder's writes pass the design gate", () => {
  beforeAll(() => setAriRequired(false));
  afterAll(() => setAriRequired(true));

  it("lands the builder's first UI write instead of refusing it", async () => {
    const root = mkdtempSync(join(tmpdir(), "lax-build-design-gate-"));
    const appDir = join(root, "workspace", "apps", "gate-app");
    mkdirSync(appDir, { recursive: true });
    const id = "design-gate-builder";
    workRootIds.add(id);
    resetDesignDeliveries();
    const runtimeDescriptor = { ...descriptor, appName: "gate-app", appDir };
    try {
      expect(registerAppBuildRuntime(op(id, "paused", runtimeDescriptor), runtimeDescriptor)).toEqual({ registered: true });
      const page = `<!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1"><title>t</title></head><body>${"x".repeat(300)}</body></html>`;
      const res = await getToolDispatcher(id).dispatch({ toolCallId: "w1", tool: "write", args: { path: join(appDir, "index.html"), content: page } });
      const text = typeof res.result === "string" ? res.result : JSON.stringify(res.result);
      expect(text).not.toContain("house design system");
      expect(existsSync(join(appDir, "index.html"))).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
