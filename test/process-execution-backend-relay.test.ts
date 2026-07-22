import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ChildProcess, fork } from "node:child_process";
import type { Op } from "../src/ops/types.js";
import type { ExecutionPlacement } from "../src/canonical-loop/types.js";
import {
  ProcessExecutionBackend,
  PROCESS_EXECUTION_BACKEND_ID,
  PROCESS_EXECUTION_TARGET_ID,
} from "../src/canonical-loop/process-execution-backend.js";
import { resolveRegisteredExecutionBackend } from "../src/canonical-loop/execution-backend-registry.js";

const originalBackend = process.env.LAX_CANONICAL_EXECUTION_BACKEND;
afterEach(() => {
  if (originalBackend === undefined) delete process.env.LAX_CANONICAL_EXECUTION_BACKEND;
  else process.env.LAX_CANONICAL_EXECUTION_BACKEND = originalBackend;
});

describe("process backend production routing and relay", () => {
  it("routes only eligible durable background operations to the process backend", () => {
    const eligible = makeOp("eligible");
    expect(resolveRegisteredExecutionBackend(undefined, eligible).id).toBe(PROCESS_EXECUTION_BACKEND_ID);
    expect(resolveRegisteredExecutionBackend("in-process", eligible).id).toBe("in-process");
    for (const candidate of [
      { ...eligible, lane: "interactive" },
      { ...eligible, type: "chat_turn" },
      { ...eligible, type: "voice_turn" },
      { ...eligible, type: "app_build" },
      { ...eligible, type: "build_app_phase" },
      { ...eligible, runtimeDescriptor: undefined },
    ] as Op[]) {
      expect(resolveRegisteredExecutionBackend(undefined, candidate).id).toBe("in-process");
    }
  });

  it("honors explicit container selection without host fallback", () => {
    process.env.LAX_CANONICAL_EXECUTION_BACKEND = "container";
    expect(resolveRegisteredExecutionBackend(undefined, makeOp("container")).id).toBe("local-container");
    process.env.LAX_CANONICAL_EXECUTION_BACKEND = "missing";
    expect(() => resolveRegisteredExecutionBackend(undefined, makeOp("missing")))
      .toThrow('Unknown configured execution backend "missing"');
  });

  it("reconciles relay notices and both successful and failed terminal exits through injected hooks", async () => {
    for (const code of [0, 17]) {
      const op = makeOp(`relay-${code}`);
      const child = fakeChild();
      const onRelayNotice = vi.fn();
      const onFinalReconcile = vi.fn();
      const done = new ProcessExecutionBackend({
        spawn: spawnReady(child),
        onRelayNotice,
        onFinalReconcile,
      }).startWithoutAdapter({ op, placement: placement() }).done;
      await vi.waitFor(() => expect(child.send).toHaveBeenCalledOnce());
      child.emit("message", {
        type: "process-relay", opId: op.id, generationId: "a".repeat(64), cursor: 1,
      });
      expect(onRelayNotice).toHaveBeenCalledOnce();
      child.emit("exit", code, null);
      if (code === 0) await expect(done).resolves.toBeUndefined();
      else await expect(done).rejects.toThrow("before completion");
      expect(onFinalReconcile).toHaveBeenCalledOnce();
      expect(onFinalReconcile).toHaveBeenCalledWith(op.id);
    }
  });
});

interface FakeChild extends EventEmitter {
  pid: number;
  send: ReturnType<typeof vi.fn>;
  kill: ReturnType<typeof vi.fn>;
}

function fakeChild(): FakeChild {
  const child = new EventEmitter() as FakeChild;
  Object.defineProperty(child, "pid", { value: 54321 });
  child.kill = vi.fn(() => true);
  child.send = vi.fn((_message: unknown, callback?: (error: Error | null) => void) => {
    queueMicrotask(() => callback?.(null));
    return true;
  });
  return child;
}

function spawnReady(child: FakeChild): typeof fork {
  return vi.fn((_path, _args, options) => {
    const token = options?.env?.LAX_PROCESS_HANDOFF_TOKEN;
    queueMicrotask(() => child.emit("message", {
      type: "ready", token, pid: child.pid, processStartedAt: new Date().toISOString(),
    }));
    return child as unknown as ChildProcess;
  }) as unknown as typeof fork;
}

function placement(): ExecutionPlacement {
  return { schemaVersion: 1, backendId: PROCESS_EXECUTION_BACKEND_ID,
    targetId: PROCESS_EXECUTION_TARGET_ID, disposition: "ready", wakeToken: null,
    wakeRequestedAt: null, revision: 1 };
}

function makeOp(label: string): Op {
  const sessionId = `session-${label}`;
  return {
    id: `op-${label}-${Math.random().toString(16).slice(2)}`, type: "delegated_task",
    task: label, model: "test", lane: "background", ownerId: "test", visibility: "private",
    status: "pending", createdAt: new Date().toISOString(), attemptCount: 0,
    retryPolicy: { maxRecoveryAttempts: 1, backoffMs: [0] },
    canonical: { flagValue: true, state: "queued", sessionId },
    contextPack: { task: { description: label, successCriteria: [], constraints: [], notWhatToRedo: [] },
      context: { recentTurns: [], referencedFiles: [], memoryHits: [], agentsRules: "" }, capabilities: {},
      budget: { maxIterations: 2, maxTokens: 0, maxWallTimeMs: 0, maxSelfEditCalls: 0 },
      routing: { lane: "background" }, secrets: { allowed: [] } },
    runtimeDescriptor: { kind: "delegated-op", adapter: "provider-exact", provider: "openai",
      credentialProvider: "openai", authSource: "config", model: "test", runtime: "openai-compat",
      target: { kind: "provider-registry", endpointFingerprint: "test" }, sessionId,
      surface: { kind: "agent-runner", systemPrompt: "test", tools: [],
        security: { workspace: ".", fileAccessMode: "workspace", inlineEvalPolicy: "refuse",
          allowedPaths: [], configFingerprint: "test" }, threatEngine: false, rbac: false,
        callContext: "delegated" }, integrity: { scheme: "hmac-sha256-v1", mac: "test" } },
  } as Op;
}
