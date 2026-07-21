import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";
import type { Op } from "../ops/types.js";
import type { ExecutionPlacement } from "./types.js";

const priorDataDir = process.env.LAX_DATA_DIR;
const dataDir = mkdtempSync(join(tmpdir(), "lax-process-backend-"));
process.env.LAX_DATA_DIR = dataDir;

const {
  ProcessExecutionBackend,
  PROCESS_EXECUTION_BACKEND_ID,
  PROCESS_EXECUTION_TARGET_ID,
} = await import("./process-execution-backend.js");
type SpawnFunction = NonNullable<
  NonNullable<ConstructorParameters<typeof ProcessExecutionBackend>[0]>["spawn"]
>;
interface MockChild extends EventEmitter {
  pid: number;
  expectedToken?: string;
  kill: () => boolean;
  send: (message: unknown, callback?: (error: Error | null) => void) => boolean;
}
const {
  claimProcessExecution,
  heartbeatProcessExecutionClaim,
  readProcessExecutionClaim,
  removeProcessExecutionClaim,
} = await import("./process-execution-claim.js");

const successFixture = join(dataDir, "success-worker.mjs");
writeFileSync(successFixture, `
process.send({ type: "ready", token: process.env.LAX_PROCESS_HANDOFF_TOKEN,
  pid: process.pid, processStartedAt: new Date().toISOString() });
process.once("message", message => {
  if (message?.type !== "start") process.exit(8);
  setTimeout(() => process.exit(0), 80);
});
`, "utf8");

const earlyExitFixture = join(dataDir, "early-exit.mjs");
writeFileSync(earlyExitFixture, "process.exit(19);", "utf8");

const invalidReadyFixture = join(dataDir, "invalid-ready.mjs");
writeFileSync(invalidReadyFixture, `
process.send({ type: "ready", token: "wrong", pid: process.pid,
  processStartedAt: new Date().toISOString() });
`, "utf8");

function makeOp(label: string): Op {
  const sessionId = `session-${label}`;
  return {
    id: `op-process-${label}-${Math.random().toString(16).slice(2)}`,
    type: "delegated_task",
    task: label,
    model: "test-model",
    runtimeDescriptor: {
      kind: "delegated-op",
      adapter: "provider-exact",
      provider: "openai",
      credentialProvider: "openai",
      authSource: "config",
      model: "test-model",
      runtime: "openai-compat",
      target: { kind: "provider-registry", endpointFingerprint: "test" },
      sessionId,
      surface: {
        kind: "agent-runner",
        systemPrompt: "test",
        tools: [],
        security: {
          workspace: dataDir,
          fileAccessMode: "workspace",
          inlineEvalPolicy: "refuse",
          allowedPaths: [],
          configFingerprint: "test",
        },
        threatEngine: false,
        rbac: false,
        callContext: "delegated",
      },
      integrity: { scheme: "hmac-sha256-v1", mac: "test" },
    },
    contextPack: {
      task: { description: label, successCriteria: [], constraints: [], notWhatToRedo: [] },
      context: { recentTurns: [], referencedFiles: [], memoryHits: [], agentsRules: "" },
      capabilities: {},
      budget: { maxIterations: 5, maxTokens: 0, maxWallTimeMs: 0, maxSelfEditCalls: 0 },
      routing: { lane: "background" },
      secrets: { allowed: [] },
    },
    lane: "background",
    retryPolicy: { maxRecoveryAttempts: 2, backoffMs: [0] },
    ownerId: "test",
    visibility: "private",
    status: "pending",
    createdAt: new Date().toISOString(),
    attemptCount: 0,
    canonical: { flagValue: true, state: "queued", sessionId },
  };
}

function placement(revision = 1): ExecutionPlacement {
  return {
    schemaVersion: 1,
    backendId: PROCESS_EXECUTION_BACKEND_ID,
    targetId: PROCESS_EXECUTION_TARGET_ID,
    disposition: "ready",
    wakeToken: null,
    wakeRequestedAt: null,
    revision,
  };
}

function fakeChild(
  sendImpl: (callback: (error: Error | null) => void, child: EventEmitter) => boolean,
): MockChild {
  const child = new EventEmitter() as MockChild;
  Object.defineProperty(child, "pid", { value: 54321 });
  child.kill = vi.fn(() => true);
  child.send = vi.fn((_message: unknown, callback?: (error: Error | null) => void) => sendImpl(
    (error) => typeof callback === "function" && callback(error),
    child,
  ));
  return child;
}

function spawnWithToken(child: MockChild): SpawnFunction {
  return vi.fn((_path, _args, options) => {
    const token = options?.env?.LAX_PROCESS_HANDOFF_TOKEN;
    child.expectedToken = token;
    queueMicrotask(() => child.emit("message", {
      type: "ready", token, pid: child.pid, processStartedAt: new Date().toISOString(),
    }));
    return child;
  }) as unknown as SpawnFunction;
}

afterAll(() => {
  if (priorDataDir === undefined) delete process.env.LAX_DATA_DIR;
  else process.env.LAX_DATA_DIR = priorDataDir;
  rmSync(dataDir, { recursive: true, force: true });
});

describe("process execution backend handoff", () => {
  it("keeps the registered production default in-process", async () => {
    const { resolveRegisteredExecutionBackend } = await import("./execution-backend-registry.js");
    expect(resolveRegisteredExecutionBackend().id).toBe("in-process");
    expect(resolveRegisteredExecutionBackend(PROCESS_EXECUTION_BACKEND_ID).id)
      .toBe(PROCESS_EXECUTION_BACKEND_ID);
  });

  it("publishes a fenced claim and completes a real child handoff", async () => {
    const candidate = makeOp("real-child");
    const done = new ProcessExecutionBackend({ entryPath: successFixture })
      .startWithoutAdapter({ op: candidate, placement: placement(3) }).done;
    await vi.waitFor(() => expect(readProcessExecutionClaim(candidate.id)?.pid).toBeGreaterThan(0));
    expect(readProcessExecutionClaim(candidate.id)?.placementRevision).toBe(3);
    await done;
    expect(readProcessExecutionClaim(candidate.id)).toBeNull();
  });

  it("fences simultaneous handoffs so only one child owns an op", async () => {
    const candidate = makeOp("collision");
    const backend = new ProcessExecutionBackend({ entryPath: successFixture });
    const results = await Promise.allSettled([
      backend.startWithoutAdapter({ op: candidate, placement: placement() }).done,
      backend.startWithoutAdapter({ op: candidate, placement: placement() }).done,
    ]);
    expect(results.filter(result => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter(result => result.status === "rejected")).toHaveLength(1);
  });

  it("rejects exit-before-ready without leaving a claim", async () => {
    const candidate = makeOp("early-exit");
    await expect(new ProcessExecutionBackend({ entryPath: earlyExitFixture })
      .startWithoutAdapter({ op: candidate, placement: placement() }).done)
      .rejects.toThrow("before durable handoff");
    expect(readProcessExecutionClaim(candidate.id)).toBeNull();
  });

  it("rejects wrong token, PID, or process start identity", async () => {
    const candidate = makeOp("invalid-ready");
    await expect(new ProcessExecutionBackend({ entryPath: invalidReadyFixture })
      .startWithoutAdapter({ op: candidate, placement: placement() }).done)
      .rejects.toThrow("ambiguous handoff identity");
    expect(readProcessExecutionClaim(candidate.id)).toBeNull();
  });

  it("treats send false as backpressure when the callback succeeds", async () => {
    const candidate = makeOp("backpressure");
    const child = fakeChild((callback, emitter) => {
      queueMicrotask(() => {
        callback(null);
        emitter.emit("exit", 0, null);
      });
      return false;
    });
    await new ProcessExecutionBackend({ spawn: spawnWithToken(child) })
      .startWithoutAdapter({ op: candidate, placement: placement() }).done;
  });

  it("stops the handoff deadline after send acknowledgement while execution continues", async () => {
    vi.useFakeTimers();
    try {
      const candidate = makeOp("long-running-after-handoff");
      const child = fakeChild(callback => {
        queueMicrotask(() => callback(null));
        return true;
      });
      const done = new ProcessExecutionBackend({
        spawn: spawnWithToken(child),
        readyTimeoutMs: 60_000,
      }).startWithoutAdapter({ op: candidate, placement: placement() }).done;

      await vi.runAllTicks();
      await vi.advanceTimersByTimeAsync(60_001);
      expect(child.kill).not.toHaveBeenCalled();
      expect(readProcessExecutionClaim(candidate.id)).not.toBeNull();

      child.emit("exit", 0, null);
      await expect(done).resolves.toBeUndefined();
      expect(readProcessExecutionClaim(candidate.id)).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("rejects send callback errors and cleans only its claim", async () => {
    const candidate = makeOp("send-error");
    const child = fakeChild(callback => {
      queueMicrotask(() => callback(new Error("ipc closed")));
      return true;
    });
    await expect(new ProcessExecutionBackend({ spawn: spawnWithToken(child) })
      .startWithoutAdapter({ op: candidate, placement: placement() }).done)
      .rejects.toThrow("ipc closed");
    expect(readProcessExecutionClaim(candidate.id)).toBeNull();
  });

  it("rejects exit after claim but before send acknowledgement", async () => {
    const candidate = makeOp("exit-before-send-ack");
    const child = fakeChild((_callback, emitter) => {
      queueMicrotask(() => emitter.emit("exit", 17, null));
      return true;
    });
    await expect(new ProcessExecutionBackend({ spawn: spawnWithToken(child) })
      .startWithoutAdapter({ op: candidate, placement: placement() }).done)
      .rejects.toThrow("before durable handoff");
    expect(readProcessExecutionClaim(candidate.id)).toBeNull();
  });

  it("rejects spawn errors and parent disconnect during handoff", async () => {
    for (const event of ["error", "disconnect"] as const) {
      const candidate = makeOp(`spawn-${event}`);
      const child = fakeChild(() => true);
      const spawn = vi.fn(() => {
        queueMicrotask(() => event === "error"
          ? child.emit("error", new Error("spawn failed"))
          : child.emit("disconnect"));
        return child;
      }) as unknown as SpawnFunction;
      await expect(new ProcessExecutionBackend({ spawn })
        .startWithoutAdapter({ op: candidate, placement: placement() }).done).rejects.toThrow();
    }
  });

  it("reclaims a stale dead claim but refuses a fresh live owner", async () => {
    const stale = makeOp("stale");
    const old = new Date(Date.now() - 60_000).toISOString();
    expect(claimProcessExecution({
      schemaVersion: 1, opId: stale.id, backendId: PROCESS_EXECUTION_BACKEND_ID,
      targetId: PROCESS_EXECUTION_TARGET_ID, placementRevision: 1, token: "old",
      pid: 77777, processStartedAt: old, heartbeatAt: old,
    })).toBe(true);
    await new ProcessExecutionBackend({ entryPath: successFixture, isPidAlive: () => false })
      .startWithoutAdapter({ op: stale, placement: placement() }).done;

    const live = makeOp("live");
    const now = new Date().toISOString();
    expect(claimProcessExecution({
      schemaVersion: 1, opId: live.id, backendId: PROCESS_EXECUTION_BACKEND_ID,
      targetId: PROCESS_EXECUTION_TARGET_ID, placementRevision: 1, token: "live",
      pid: process.pid, processStartedAt: now, heartbeatAt: now,
    })).toBe(true);
    expect(() => new ProcessExecutionBackend({ isPidAlive: () => true })
      .startWithoutAdapter({ op: live, placement: placement() })).toThrow("live process owner");
  });

  it("never heartbeats or removes a replacement owner's claim", () => {
    const candidate = makeOp("claim-fence");
    const now = new Date().toISOString();
    const owner = {
      schemaVersion: 1 as const,
      opId: candidate.id,
      backendId: PROCESS_EXECUTION_BACKEND_ID,
      targetId: PROCESS_EXECUTION_TARGET_ID,
      placementRevision: 1,
      token: "owner",
      pid: 1234,
      processStartedAt: now,
      heartbeatAt: now,
    };
    expect(claimProcessExecution(owner)).toBe(true);
    const staleIdentity = { ...owner, token: "stale", pid: 4321 };
    expect(heartbeatProcessExecutionClaim(staleIdentity, new Date().toISOString())).toBe(false);
    expect(removeProcessExecutionClaim(staleIdentity)).toBe(false);
    expect(readProcessExecutionClaim(candidate.id)?.token).toBe("owner");
    expect(removeProcessExecutionClaim(owner)).toBe(true);
  });

  it("limits eligibility to exact durable non-interactive delegated ops", () => {
    const allowed = makeOp("eligible");
    expect(ProcessExecutionBackend.isEligible(allowed)).toBe(true);
    for (const mutate of [
      (op: Op) => { op.lane = "interactive"; },
      (op: Op) => { op.lane = "build"; },
      (op: Op) => { op.type = "chat_turn"; },
      (op: Op) => { op.type = "voice_turn"; },
      (op: Op) => { op.type = "app_build_worker"; },
      (op: Op) => { op.runtimeDescriptor = { kind: "delegated-op", adapter: "lane-default" }; },
      (op: Op) => {
        if (op.runtimeDescriptor?.kind === "delegated-op"
          && op.runtimeDescriptor.adapter === "provider-exact") op.runtimeDescriptor.surface = undefined;
      },
      (op: Op) => { if (op.canonical) op.canonical.sessionId = "other"; },
    ]) {
      const candidate = makeOp(Math.random().toString(16));
      mutate(candidate);
      expect(ProcessExecutionBackend.isEligible(candidate)).toBe(false);
    }
  });

  it("relays durable cancellation and approval resolution without a new ask", async () => {
    const { readOp, writeOp } = await import("../ops/op-store.js");
    const { getApprovalManager } = await import("../approval-manager.js");
    const { subscribeOpSignals } = await import("./signals.js");
    const { startProcessControlRelay } = await import("./process-control-relay.js");
    const candidate = makeOp("controls");
    candidate.canonical!.state = "running";
    writeOp(candidate);
    let approvalId = "";
    const decision = getApprovalManager().requestApprovalDetailed({
      toolName: "shell",
      toolCallId: "control-call",
      sessionId: candidate.canonical!.sessionId!,
      context: "test",
      args: { command: "git status" },
      alwaysAsk: true,
      emit: event => {
        if (event.type === "approval_requested") approvalId = event.approvalId;
      },
    });
    expect(approvalId).not.toBe("");
    const signals: string[] = [];
    const unsubscribe = subscribeOpSignals(candidate.id, signal => signals.push(signal.kind));
    const stop = startProcessControlRelay(candidate.id, 5);
    const fresh = readOp(candidate.id)!;
    fresh.canonical!.cancelRequestedAt = new Date().toISOString();
    fresh.canonical!.pendingApproval = {
      approvalId,
      toolName: "shell",
      toolCallId: "control-call",
      argsPreview: "{}",
      context: "test",
      requestedAt: Date.now(),
      resolution: { approved: true, resolvedAt: Date.now() },
    };
    writeOp(fresh);
    try {
      await vi.waitFor(() => expect(signals).toContain("cancel"));
      await expect(decision).resolves.toMatchObject({ approved: true });
    } finally {
      stop();
      unsubscribe();
    }
  });

  it("boots the real child entry and reconstructs the canonical runtime fail-closed", async () => {
    const { readOp, writeOp } = await import("../ops/op-store.js");
    const candidate = makeOp("real-entry");
    candidate.canonical!.executionPlacement = placement(4);
    writeOp(candidate);
    const entryPath = new URL("./process-worker-entry.ts", import.meta.url)
      .pathname.replace(/^\/(.:\/)/, "$1");
    const tsxLoader = new URL("../../../../node_modules/tsx/dist/loader.mjs", import.meta.url).href;
    await new ProcessExecutionBackend({ entryPath, execArgv: ["--import", tsxLoader] })
      .startWithoutAdapter({ op: candidate, placement: placement(4) }).done;
    expect(readOp(candidate.id)?.canonical?.state).toBe("failed");
    expect(readOp(candidate.id)?.lastFailureReason).toBe("runtime_reconstruction:identity_mismatch");
    expect(readProcessExecutionClaim(candidate.id)).toBeNull();
  }, 45_000);
});
