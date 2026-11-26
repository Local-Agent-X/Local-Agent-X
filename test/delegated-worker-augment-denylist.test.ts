/**
 * Regression: the delegated-worker denylist must hold at tool_search
 * AUGMENTATION time, not only at spawn time.
 *
 * W2 gave delegated workers a curated read/search belt (spawn-time
 * subtraction). But `tool_search` can re-acquire ANY registry tool at
 * runtime: augmentFromToolSearch unions discovered tools into the executable
 * toolMap + registerToolsForOp. Without a re-check, a "read-only" worker could
 * tool_search its way back to op_submit_async (unbounded fan-out),
 * mission_schedule_* (unattended cron), or write/edit.
 *
 * These tests prove the fix: when callContext === "delegated", discovered
 * tools pass through the SAME isDeniedForDelegatedWorker predicate (one source
 * of truth). Non-delegated contexts ("api") stay unfiltered — proving no
 * behavior change off the delegated path.
 *
 * The registry is the live unifiedRegistry singleton (no second registry is
 * constructed) — each test registers exactly the tools it needs and
 * unregisters them afterwards.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Audience, ToolDefinition } from "../src/types.js";
import type { Op } from "../src/ops/types.js";
import { unifiedRegistry } from "../src/tools/registry.js";
import { augmentByName, augmentFromToolSearch, canCallByName } from "../src/canonical-loop/tool-augmentation.js";
import { getToolsForOp, unregisterToolsForOp } from "../src/canonical-loop/runtime.js";
import { writeOp } from "../src/ops/op-store.js";

const registered: string[] = [];
const ops: string[] = [];
let priorDataDir: string | undefined;
let dataDir: string;

beforeEach(() => {
  priorDataDir = process.env.LAX_DATA_DIR;
  dataDir = mkdtempSync(join(tmpdir(), "augment-denylist-"));
  process.env.LAX_DATA_DIR = dataDir;
});

function mkTool(name: string): ToolDefinition {
  return {
    name,
    description: `test tool ${name}`,
    parameters: { type: "object", properties: {} },
    execute: async () => ({ content: "ok" }),
    audiences: ["spawned-agent"] as Audience[],
  };
}

function registerAll(names: string[]): void {
  for (const name of names) {
    unifiedRegistry.register(mkTool(name));
    registered.push(name);
  }
}

/** tool_search's on-the-wire output: a JSON array of tool schemas. */
function toolSearchResult(names: string[]): string {
  return JSON.stringify(names.map((name) => ({
    name,
    description: `test tool ${name}`,
    parameters: { type: "object", properties: {} },
  })));
}

afterEach(() => {
  for (const name of registered.splice(0)) unifiedRegistry.unregister(name);
  for (const opId of ops.splice(0)) unregisterToolsForOp(opId);
  if (priorDataDir === undefined) delete process.env.LAX_DATA_DIR;
  else process.env.LAX_DATA_DIR = priorDataDir;
  rmSync(dataDir, { recursive: true, force: true });
});

/** A persisted delegated op record: the belt (lane + work root) augmentation
 *  reads is the op's own, durable on disk. */
function persistOp(opId: string, lane: Op["lane"], workRoot?: string, buildWorker = false): void {
  writeOp({
    id: opId,
    type: "freeform",
    task: "t",
    lane,
    retryPolicy: { maxRecoveryAttempts: 0, backoffMs: [] },
    ownerId: "local-user",
    visibility: "private",
    status: "running",
    createdAt: new Date().toISOString(),
    attemptCount: 0,
    contextPack: {
      task: { description: "t", successCriteria: [], constraints: [], notWhatToRedo: [] },
      context: { recentTurns: [], referencedFiles: [], memoryHits: [], agentsRules: "" },
      capabilities: {},
      budget: { maxIterations: 1, maxTokens: 0, maxWallTimeMs: 1, maxSelfEditCalls: 0 },
      routing: { lane, ...(workRoot ? { workRoot } : {}), ...(buildWorker ? { buildWorker: true } : {}) },
      secrets: { allowed: [] },
    },
  });
}

describe("augmentFromToolSearch delegated denylist", () => {
  // A denied tool (op_submit_async — unbounded fan-out) and a benign
  // read-only tool discovered in the same tool_search result.
  const DENIED = "op_submit_async";
  const ALLOWED = "fake_read_only";

  it("drops denied tools when callContext is 'delegated', keeps allowed ones", () => {
    registerAll([DENIED, ALLOWED, "write"]);
    const opId = "op_delegated_test_0001";
    ops.push(opId);
    const toolMap = new Map<string, ToolDefinition>();
    let augmentedNames: string[] = [];

    augmentFromToolSearch(
      toolSearchResult([DENIED, "write", ALLOWED]),
      opId,
      toolMap,
      (tools) => { augmentedNames = tools.map((t) => t.name); },
      "delegated",
    );

    // Denied tools never enter the executable toolMap...
    expect(toolMap.has(DENIED)).toBe(false);
    expect(toolMap.has("write")).toBe(false);
    // ...nor the schema-visible augmentation the model would next see.
    expect(augmentedNames).not.toContain(DENIED);
    expect(augmentedNames).not.toContain("write");
    // The benign read-only tool passes through.
    expect(toolMap.has(ALLOWED)).toBe(true);
    expect(augmentedNames).toContain(ALLOWED);
    // And is re-registered on the op so the next request schema includes it.
    expect(getToolsForOp(opId).map((t) => t.name)).toEqual([ALLOWED]);
  });

  it("a build worker with a work root may re-acquire its mutation belt, and nothing else that is denied", () => {
    registerAll([DENIED, ALLOWED, "write", "bash", "bulk_replace", "mission_schedule_create"]);
    const opId = "op_delegated_build_0001";
    ops.push(opId);
    persistOp(opId, "build", "C:/ws/apps/proj");
    const toolMap = new Map<string, ToolDefinition>();

    augmentFromToolSearch(
      toolSearchResult([DENIED, "write", "bash", "bulk_replace", "mission_schedule_create", ALLOWED]),
      opId,
      toolMap,
      undefined,
      "delegated",
    );

    expect([...toolMap.keys()].sort()).toEqual(["bash", ALLOWED, "write"].sort());
    expect(getToolsForOp(opId).map((t) => t.name).sort()).toEqual(["bash", ALLOWED, "write"].sort());
  });

  // The worker that was refused `android` three times and drove adb through
  // bash instead (2026-11-26): what a build reaches loads like any other tool.
  it("a build worker with a work root loads the phone, office and API tools it searches for", () => {
    registerAll(["android", "device_check", "http_request", "presentation", "process_start"]);
    const opId = "op_delegated_build_reach_0001";
    ops.push(opId);
    persistOp(opId, "build", "C:/ws/apps/proj");
    const toolMap = new Map<string, ToolDefinition>();

    augmentFromToolSearch(toolSearchResult(["android", "device_check", "http_request", "presentation", "process_start"]), opId, toolMap, undefined, "delegated");

    expect([...toolMap.keys()].sort()).toEqual(["android", "device_check", "http_request", "presentation"]);
    expect(canCallByName("ios", opId, toolMap, "delegated")).toBe(false); // not registered here
    expect(augmentByName("process_start", opId, toolMap, undefined, "delegated")).toBe(false);
  });

  it("a worker without a work root is still refused them", () => {
    registerAll([ALLOWED, "android", "presentation"]);
    const opId = "op_delegated_readonly_reach_0001";
    ops.push(opId);
    persistOp(opId, "background");
    const toolMap = new Map<string, ToolDefinition>();

    augmentFromToolSearch(toolSearchResult(["android", "presentation", ALLOWED]), opId, toolMap, undefined, "delegated");

    expect([...toolMap.keys()]).toEqual([ALLOWED]);
  });

  it("a build worker WITHOUT a work root stays read-only at augmentation time", () => {
    registerAll([ALLOWED, "write", "bash"]);
    const opId = "op_delegated_build_0002";
    ops.push(opId);
    persistOp(opId, "build");
    const toolMap = new Map<string, ToolDefinition>();

    augmentFromToolSearch(toolSearchResult(["write", "bash", ALLOWED]), opId, toolMap, undefined, "delegated");

    expect([...toolMap.keys()]).toEqual([ALLOWED]);
  });

  // The owner's ruling, 2026-11-26: a build's chunk worker holds what its
  // lead's chat could, except what its role rules out. Bounded to its kit, a
  // worker told to test on the phone was refused the phone tool and drove adb
  // through the shell, and one that needed a dev server left it running.
  it("a build's chunk worker loads what its lead could, and is refused only what its role rules out", () => {
    const MAY = [ALLOWED, "android", "http_request", "process_start", "process_kill", "device_check", "browser"];
    const MAY_NOT = ["agent_spawn", "op_submit_async", "holdout_write", "holdout_judge", "build_decide", "run_build_plan", "build_plan_resume"];
    registerAll([...MAY, ...MAY_NOT].filter((n) => !unifiedRegistry.get(n)));
    const opId = "op_agent_builder_0001";
    ops.push(opId);
    persistOp(opId, "agent", "/work/root", true);
    const toolMap = new Map<string, ToolDefinition>();

    for (const name of MAY) expect(canCallByName(name, opId, toolMap, "delegated"), name).toBe(true);
    for (const name of MAY_NOT) expect(canCallByName(name, opId, toolMap, "delegated"), name).toBe(false);
    augmentFromToolSearch(toolSearchResult(["android", "holdout_write", "agent_spawn"]), opId, toolMap, undefined, "delegated");
    expect([...toolMap.keys()]).toEqual(["android"]);
  });

  it("a reviewer, and any other spawned agent in a work root, stays bounded to what it was given", () => {
    registerAll(["android"].filter((n) => !unifiedRegistry.get(n)));
    const opId = "op_agent_reviewer_0001";
    ops.push(opId);
    persistOp(opId, "agent", "/work/root");
    expect(canCallByName("android", opId, new Map(), "delegated")).toBe(false);
    expect(canCallByName(ALLOWED, opId, new Map(), "delegated")).toBe(false);
  });

  // A spawned agent's allow-list is its whole surface, resolved in full when
  // it started: nothing is added later, whether found by tool_search or
  // called by name. (Before, any registered tool a spawned agent named was
  // loaded, so its list limited what it knew of, not what it could do.)
  it("a spawned agent (the agent lane) is bounded: nothing is admitted, by search or by name", () => {
    registerAll([ALLOWED, "write"]);
    const opId = "op_agent_bounded_0001";
    ops.push(opId);
    persistOp(opId, "agent");
    const toolMap = new Map<string, ToolDefinition>();
    let augmented = false;

    augmentFromToolSearch(toolSearchResult([ALLOWED, "write"]), opId, toolMap, () => { augmented = true; }, "delegated");
    expect(toolMap.size).toBe(0);
    expect(augmented).toBe(false);
    expect(augmentByName(ALLOWED, opId, toolMap, undefined, "delegated")).toBe(false);
    expect(canCallByName(ALLOWED, opId, toolMap, "delegated")).toBe(false);
    // What it was started with, it keeps.
    toolMap.set(ALLOWED, unifiedRegistry.get(ALLOWED)!);
    expect(canCallByName(ALLOWED, opId, toolMap, "delegated")).toBe(true);
  });

  it("leaves discovery unfiltered for non-delegated context ('api')", () => {
    registerAll([DENIED, ALLOWED, "write"]);
    const opId = "op_api_test_0001";
    ops.push(opId);
    const toolMap = new Map<string, ToolDefinition>();
    let augmentedNames: string[] = [];

    augmentFromToolSearch(
      toolSearchResult([DENIED, "write", ALLOWED]),
      opId,
      toolMap,
      (tools) => { augmentedNames = tools.map((t) => t.name); },
      "api",
    );

    // Non-delegated: EVERY discovered tool passes — behavior unchanged.
    for (const name of [DENIED, "write", ALLOWED]) {
      expect(toolMap.has(name)).toBe(true);
      expect(augmentedNames).toContain(name);
    }
    expect(getToolsForOp(opId).map((t) => t.name).sort())
      .toEqual([DENIED, ALLOWED, "write"].sort());
  });
});
