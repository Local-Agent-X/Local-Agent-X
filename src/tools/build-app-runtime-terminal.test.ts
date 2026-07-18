import { afterAll, describe, expect, it } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Adapter, AdapterReport, ToolCall, TurnInput, TurnResult } from "../canonical-loop/adapter-contract.js";
import type { AppBuildRuntimeDescriptor, Op } from "../ops/types.js";

const previousLaxDir = process.env.LAX_DATA_DIR;
const dataDir = mkdtempSync(join(tmpdir(), "lax-build-runtime-terminal-"));
process.env.LAX_DATA_DIR = dataDir;

const {
  awaitCanonicalOp,
  awaitIdle,
  canonicalLoopEntry,
  readCanonicalEvents,
  registerAdapterForOp,
  resetCanonicalRuntime,
  resetScheduler,
} = await import("../canonical-loop/index.js");
const { readOp } = await import("../ops/op-store.js");
const { registerAppBuildRuntime } = await import("./build-app-runtime.js");

afterAll(() => {
  resetCanonicalRuntime();
  resetScheduler();
  if (previousLaxDir === undefined) delete process.env.LAX_DATA_DIR;
  else process.env.LAX_DATA_DIR = previousLaxDir;
  rmSync(dataDir, { recursive: true, force: true });
});

function mutationAdapter(targetPath: string): Adapter {
  return {
    name: "quick-build-mutation-test",
    version: "1",
    async runTurn(_input: TurnInput, report: (event: AdapterReport) => void): Promise<TurnResult> {
      const call: ToolCall = {
        toolCallId: "write-after-product-ownership",
        tool: "write",
        args: { path: targetPath, content: "must not be written" },
      };
      report({ kind: "tool_call_requested", call });
      report({
        kind: "message_finalized",
        message: {
          messageId: "quick-build-write-request",
          role: "assistant",
          content: { text: "", toolCalls: [call] },
        },
      });
      return {
        providerState: {
          adapterName: "quick-build-mutation-test",
          adapterVersion: "1",
          providerPayload: null,
        },
        modelStop: "continue",
      };
    },
    async abort() { /* no provider request is running */ },
  };
}

describe("Quick Build ownership guard terminal path", () => {
  it("fails the op instead of dispatching or retrying a mid-turn mutation", async () => {
    const appDir = join(dataDir, "owned-app");
    const targetPath = join(appDir, "blocked.txt");
    mkdirSync(appDir, { recursive: true });

    const descriptor: AppBuildRuntimeDescriptor = {
      kind: "app-build",
      strategy: "in-canonical-sub-agent",
      provider: "test-provider",
      appName: "owned-app",
      appDir,
      appUrl: "/apps/owned-app/",
      prompt: "Build it",
      brief: "Build it",
      systemPrompt: "You build apps.",
      tier: "quick-html",
    };
    const op: Op = {
      id: `op-product-ownership-terminal-${process.pid}`,
      type: "app_build",
      task: "Build app",
      contextPack: {
        task: { description: "Build app", successCriteria: [], constraints: [], notWhatToRedo: [] },
        context: { recentTurns: [], referencedFiles: [], memoryHits: [], agentsRules: "" },
        capabilities: {},
        budget: { maxIterations: 4, maxTokens: 0, maxWallTimeMs: 0, maxSelfEditCalls: 0 },
        routing: { lane: "build" },
        secrets: { allowed: [] },
      },
      lane: "build",
      retryPolicy: { maxRecoveryAttempts: 1, backoffMs: [0] },
      runtimeDescriptor: descriptor,
      ownerId: "local-user",
      visibility: "private",
      status: "pending",
      createdAt: new Date().toISOString(),
      attemptCount: 0,
      model: "fake-test-model",
    };

    expect(registerAppBuildRuntime(op, descriptor)).toEqual({ registered: true });
    registerAdapterForOp(op.id, () => mutationAdapter(targetPath));

    mkdirSync(join(appDir, "spec"), { recursive: true });
    writeFileSync(join(appDir, "spec", "plan.md"), "# Product plan\n", "utf-8");

    canonicalLoopEntry(op);
    const result = await awaitCanonicalOp(op.id, 10_000);
    await awaitIdle(5_000);

    expect(result?.status).toBe("failed");
    expect(readOp(op.id)?.canonical?.state).toBe("failed");
    expect(existsSync(targetPath)).toBe(false);
    const error = readCanonicalEvents(op.id).find((event) => event.type === "error");
    expect(error?.body).toMatchObject({
      code: "worker_exception",
      message: expect.stringContaining("Product Build now owns this project"),
      retryable: false,
    });
  }, 15_000);
});
