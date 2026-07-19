import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  appendOpMessage,
  awaitIdle,
  commitTurn,
  readOpMessages,
  readOpTurns,
  readCanonicalEvents,
  recoverStaleOp,
  registerAdapterForOp,
  resetBus,
  resetCanonicalRuntime,
  resetScheduler,
  setDefaultAdapterForLane,
} from "../src/canonical-loop/index.js";
import { FakeAdapter, scriptTurn } from "./canonical-loop/fake-adapter.js";
import { readOp, writeOp } from "../src/ops/op-store.js";
import {
  getSessionForOp,
  releaseOpFromSession,
  trackOpForSession,
} from "../src/ops/session-bridge.js";
import { resetCircuit } from "../src/ops/heartbeat.js";
import type { Op } from "../src/ops/types.js";

let priorDataDir: string | undefined;
let dataDir: string;

beforeEach(() => {
  priorDataDir = process.env.LAX_DATA_DIR;
  dataDir = mkdtempSync(join(tmpdir(), "canonical-rehydrate-"));
  process.env.LAX_DATA_DIR = dataDir;
  resetCanonicalRuntime();
  resetScheduler();
  resetBus();
});

afterEach(async () => {
  await awaitIdle(3_000).catch(() => undefined);
  resetScheduler();
  resetCanonicalRuntime();
  resetBus();
  resetCircuit("rehydration-test");
  if (priorDataDir === undefined) delete process.env.LAX_DATA_DIR;
  else process.env.LAX_DATA_DIR = priorDataDir;
  rmSync(dataDir, { recursive: true, force: true });
});

describe("canonical recovery runtime rehydration", () => {
  it("continues after the last committed checkpoint without replaying its completed tool", async () => {
    const op: Op = {
      id: "op_rehydration_test",
      type: "rehydration-test",
      task: "continue durable work",
      lane: "background",
      contextPack: {
        task: {
          description: "continue durable work",
          successCriteria: [],
          constraints: [],
          notWhatToRedo: [],
        },
        context: { recentTurns: [], referencedFiles: [], memoryHits: [], agentsRules: "" },
        capabilities: {},
        budget: { maxIterations: 8, maxTokens: 0, maxWallTimeMs: 0, maxSelfEditCalls: 0 },
        routing: { lane: "background" },
        secrets: { allowed: [] },
      },
      retryPolicy: { maxRecoveryAttempts: 3, backoffMs: [] },
      runtimeDescriptor: {
        kind: "delegated-op",
        adapter: "provider-exact",
        provider: "local",
        credentialProvider: "local",
        model: "test-model",
        runtime: "openai-compat",
        baseURL: "http://127.0.0.1:11434/v1",
        sessionId: "session-rehydration",
      },
      ownerId: "local-user",
      visibility: "private",
      status: "running",
      createdAt: new Date().toISOString(),
      attemptCount: 0,
      model: "test-model",
      canonical: {
        flagValue: true,
        state: "running",
        sessionId: "session-rehydration",
        leaseOwner: "dead-worker",
        leaseExpiresAt: new Date(Date.now() - 1_000).toISOString(),
      },
    };
    writeOp(op);
    appendOpMessage({
      messageId: "request-0",
      opId: op.id,
      turnIdx: 0,
      seqInTurn: 0,
      role: "user",
      content: { text: "continue durable work" },
      createdAt: new Date().toISOString(),
    });
    commitTurn({
      op,
      turnIdx: 0,
      providerState: {
        adapterName: "fake",
        adapterVersion: "0.0.1",
        providerPayload: { cursor: "checkpoint-0" },
      },
      messages: [
        {
          role: "assistant",
          content: {
            text: "write finished",
            toolCalls: [{ toolCallId: "call-1", tool: "write", args: { path: "notes.txt" } }],
          },
        },
        { role: "tool_result", content: { text: "saved result", toolCallId: "call-1" } },
      ],
      toolCallSummary: [{ tool: "write", argsHash: "hash-1", resultStatus: "ok", durationMs: 4 }],
      terminalReason: null,
    });

    trackOpForSession(op.id, "session-rehydration", op.task);
    resetScheduler();
    resetCanonicalRuntime();
    releaseOpFromSession(op.id);

    const replacement = new FakeAdapter({
      script: [scriptTurn({ text: "continued from checkpoint", terminal: "done" })],
    });
    registerAdapterForOp(op.id, () => replacement);

    expect(readOp(op.id)?.runtimeDescriptor).toEqual({
      kind: "delegated-op",
      adapter: "provider-exact",
      provider: "local",
      credentialProvider: "local",
      model: "test-model",
      runtime: "openai-compat",
      baseURL: "http://127.0.0.1:11434/v1",
      sessionId: "session-rehydration",
    });

    const outcome = recoverStaleOp(op.id);
    expect(outcome.kind).toBe("recovered");
    expect(getSessionForOp(op.id)).toBe("session-rehydration");
    const deadline = Date.now() + 3_000;
    while (readOp(op.id)?.canonical?.state !== "succeeded") {
      if (readOp(op.id)?.canonical?.state === "failed" || Date.now() > deadline) {
        throw new Error(
          `recovered operation did not reach succeeded: state=${readOp(op.id)?.canonical?.state} `
          + `turns=${readOpTurns(op.id).length} inputs=${replacement.turnInputs.length} `
          + `events=${JSON.stringify(readCanonicalEvents(op.id).slice(-3))}`,
        );
      }
      await new Promise(resolve => setTimeout(resolve, 5));
    }
    await awaitIdle();

    expect(readOp(op.id)?.canonical?.state).toBe("succeeded");
    expect(readOp(op.id)?.attemptCount).toBe(1);
    expect(replacement.turnInputs).toHaveLength(1);
    expect(replacement.turnInputs[0].turnIdx).toBe(1);
    expect(replacement.turnInputs[0].providerState?.providerPayload).toEqual({ cursor: "checkpoint-0" });
    expect(replacement.turnInputs[0].messages.filter(message => message.role === "tool_result")).toHaveLength(1);

    const turns = readOpTurns(op.id);
    expect(turns.map(turn => turn.turnIdx)).toEqual([0, 1]);
    expect(turns[0].toolCallSummary).toEqual([
      { tool: "write", argsHash: "hash-1", resultStatus: "ok", durationMs: 4 },
    ]);
    const persistedToolResults = readOpMessages(op.id).filter(message => message.role === "tool_result");
    expect(persistedToolResults).toHaveLength(1);
    expect(persistedToolResults[0].content).toEqual({ text: "saved result", toolCallId: "call-1" });
  });

  it.each([
    ["absent", undefined],
    ["malformed", { kind: "delegated-op", adapter: "unknown" }],
  ])("fails closed for a queued restart with an %s runtime descriptor", async (_label, descriptor) => {
    const op: Op = {
      id: `op_queued_${_label}`,
      type: "rehydration-test",
      task: "legacy queued work",
      lane: "background",
      contextPack: {
        task: {
          description: "legacy queued work",
          successCriteria: [],
          constraints: [],
          notWhatToRedo: [],
        },
        context: { recentTurns: [], referencedFiles: [], memoryHits: [], agentsRules: "" },
        capabilities: {},
        budget: { maxIterations: 8, maxTokens: 0, maxWallTimeMs: 0, maxSelfEditCalls: 0 },
        routing: { lane: "background" },
        secrets: { allowed: [] },
      },
      retryPolicy: { maxRecoveryAttempts: 3, backoffMs: [] },
      ...(descriptor ? { runtimeDescriptor: descriptor as never } : {}),
      ownerId: "local-user",
      visibility: "private",
      status: "pending",
      createdAt: new Date().toISOString(),
      attemptCount: 0,
      model: "test-model",
      canonical: {
        flagValue: true,
        state: "queued",
        leaseOwner: null,
        leaseExpiresAt: null,
      },
    };
    writeOp(op);

    resetScheduler();
    resetCanonicalRuntime();
    const wrongProvider = new FakeAdapter({
      script: [scriptTurn({ text: "wrong provider ran", terminal: "done" })],
    });
    setDefaultAdapterForLane("background", () => wrongProvider);

    expect(recoverStaleOp(op.id).kind).toBe("recovered");
    const deadline = Date.now() + 3_000;
    while (readOp(op.id)?.canonical?.state !== "failed") {
      if (Date.now() > deadline) throw new Error("queued unsupported operation did not fail closed");
      await new Promise(resolve => setTimeout(resolve, 5));
    }
    await awaitIdle();

    expect(readOp(op.id)?.attemptCount).toBe(0);
    expect(wrongProvider.turnInputs).toHaveLength(0);
    const errors = readCanonicalEvents(op.id).filter(event => event.type === "error");
    expect(errors.at(-1)?.body?.code).toBe("adapter_registration_lost");
  });
});
