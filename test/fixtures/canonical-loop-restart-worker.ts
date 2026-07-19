import { appendFileSync, readFileSync, rmSync } from "node:fs";

import {
  appendOpMessage,
  awaitIdle,
  commitTurn,
  readOpMessages,
  readOpTurns,
  registerToolDispatcherForOp,
  registerToolsForOp,
  setDefaultAdapterForLane,
} from "../../src/canonical-loop/index.js";
import type {
  Adapter,
  AdapterReport,
  TurnInput,
  TurnResult,
} from "../../src/canonical-loop/adapter-contract.js";
import { stopRecoveryJanitor } from "../../src/canonical-loop/recovery-janitor.js";
import { readOp, writeOp } from "../../src/ops/op-store.js";
import { getSessionForOp } from "../../src/ops/session-bridge.js";
import type { Op } from "../../src/ops/types.js";
import { bootstrapCanonicalLoop } from "../../src/server/canonical-loop-bootstrap.js";
import { opTurnPath } from "../../src/canonical-loop/schema.js";

const [action, opId, sideEffectLedger, mutation] = process.argv.slice(2);

function result(value: unknown): never {
  process.stdout.write(`@@RESULT@@${JSON.stringify(value)}`);
  process.exit(0);
}

function fail(error: unknown): never {
  const message = error instanceof Error ? error.stack ?? error.message : String(error);
  process.stderr.write(message);
  process.exit(1);
}

function contextPack(task: string): Op["contextPack"] {
  return {
    task: { description: task, successCriteria: [], constraints: [], notWhatToRedo: [] },
    context: { recentTurns: [], referencedFiles: [], memoryHits: [], agentsRules: "" },
    capabilities: {},
    budget: { maxIterations: 8, maxTokens: 0, maxWallTimeMs: 0, maxSelfEditCalls: 0 },
    routing: { lane: "background" },
    secrets: { allowed: [] },
  };
}

function persistInterruptedOperation(): never {
  const task = "resume delegated work after restart";
  const op: Op = {
    id: opId,
    type: "restart-proof",
    task,
    contextPack: contextPack(task),
    lane: "background",
    retryPolicy: { maxRecoveryAttempts: 3, backoffMs: [] },
    runtimeDescriptor: {
      kind: "delegated-op",
      adapter: "lane-default",
      sessionId: "session-across-restart",
    },
    ownerId: "local-user",
    visibility: "private",
    status: "running",
    createdAt: new Date().toISOString(),
    attemptCount: 0,
    model: "restart-proof-model",
    canonical: {
      flagValue: true,
      state: "running",
      sessionId: "session-across-restart",
      leaseOwner: "worker-process-a",
      leaseExpiresAt: new Date(Date.now() - 1_000).toISOString(),
    },
  };
  writeOp(op);
  appendOpMessage({
    messageId: "request-0",
    opId,
    turnIdx: 0,
    seqInTurn: 0,
    role: "user",
    content: { text: task },
    createdAt: new Date().toISOString(),
  });

  appendFileSync(sideEffectLedger, `${JSON.stringify({ opId, effect: "write", callId: "call-1" })}\n`);
  commitTurn({
    op,
    turnIdx: 0,
    providerState: {
      adapterName: "restart-proof-provider",
      adapterVersion: "1",
      providerPayload: {
        cursor: "checkpoint-0",
        providerSession: "provider-session-a",
      },
    },
    messages: [
      {
        role: "assistant",
        content: {
          text: "durable write completed",
          toolCalls: [{ toolCallId: "call-1", tool: "write", args: { path: "durable.txt" } }],
        },
      },
      { role: "tool_result", content: { text: "saved", toolCallId: "call-1" } },
    ],
    toolCallSummary: [{ tool: "write", argsHash: "hash-1", resultStatus: "ok", durationMs: 3 }],
    terminalReason: null,
  });
  result({ state: readOp(opId)?.canonical?.state, turns: readOpTurns(opId).length });
}

class ResumeAdapter implements Adapter {
  readonly name = "restart-proof-provider";
  readonly version = "1";
  inputs: TurnInput[] = [];
  executionIdentities: Array<Record<string, unknown>> = [];
  trackedSessionDuringResume: string | undefined;
  private replayAttempted = false;

  constructor(
    private readonly configuredModel: string,
    private readonly configuredRuntime: "lane-default",
  ) {}

  async runTurn(input: TurnInput, report: (value: AdapterReport) => void): Promise<TurnResult> {
    this.inputs.push(input);
    this.trackedSessionDuringResume = getSessionForOp(opId);
    const payload = input.providerState?.providerPayload as Record<string, unknown> | undefined;
    const identity = {
      adapterName: this.name,
      adapterVersion: this.version,
      checkpointAdapterName: input.providerState?.adapterName,
      checkpointAdapterVersion: input.providerState?.adapterVersion,
      cursor: payload?.cursor,
      providerSession: payload?.providerSession,
      configuredModel: this.configuredModel,
      configuredRuntime: this.configuredRuntime,
      canonicalSession: this.trackedSessionDuringResume,
      turnIdx: input.turnIdx,
      tools: input.tools.map(tool => tool.name),
    };
    this.executionIdentities.push(identity);

    const recoveredExpectedIdentity =
      input.turnIdx === 1
      && identity.checkpointAdapterName === this.name
      && identity.checkpointAdapterVersion === this.version
      && identity.cursor === "checkpoint-0"
      && identity.providerSession === "provider-session-a"
      && identity.configuredModel === "restart-proof-model"
      && identity.configuredRuntime === "lane-default"
      && identity.canonicalSession === "session-across-restart";
    if (!recoveredExpectedIdentity && !this.replayAttempted) {
      this.replayAttempted = true;
      const call = { toolCallId: "call-1", tool: "write", args: { path: "durable.txt" } };
      report({ kind: "tool_call_requested", call });
      report({
        kind: "message_finalized",
        message: {
          messageId: "replayed-0",
          role: "assistant",
          content: { text: "replaying durable write", toolCalls: [call] },
        },
      });
      return {
        providerState: input.providerState ?? {
          adapterName: this.name,
          adapterVersion: this.version,
          providerPayload: {},
        },
        modelStop: "continue",
      };
    }
    report({
      kind: "message_finalized",
      message: {
        messageId: "continued-1",
        role: "assistant",
        content: { text: "continued without replay" },
      },
    });
    return {
      providerState: {
        adapterName: this.name,
        adapterVersion: this.version,
        providerPayload: {
          cursor: "checkpoint-1",
          providerSession: "provider-session-a",
        },
      },
      terminalReason: "done",
      modelStop: "ended",
    };
  }

  async abort(): Promise<void> {}
}

function selectDurableRuntime(): {
  adapter: "lane-default";
  model: string;
  sessionId: string;
} {
  const op = readOp(opId);
  if (!op) throw new Error("durable operation missing");
  if (op.model !== "restart-proof-model") {
    throw new Error(`durable model identity mismatch: ${op.model ?? "missing"}`);
  }
  const descriptor = op.runtimeDescriptor;
  if (
    descriptor?.kind !== "delegated-op"
    || descriptor.adapter !== "lane-default"
    || descriptor.sessionId !== "session-across-restart"
  ) {
    throw new Error(`durable runtime identity mismatch: ${JSON.stringify(descriptor)}`);
  }
  return { adapter: descriptor.adapter, model: op.model, sessionId: descriptor.sessionId };
}

function applyMutation(): void {
  if (mutation === "replay-from-zero") {
    rmSync(opTurnPath(opId, 0));
    return;
  }
  if (mutation !== "wrong-model" && mutation !== "wrong-runtime") return;
  const op = readOp(opId);
  if (!op) throw new Error("durable operation missing for mutation");
  if (mutation === "wrong-model") op.model = "mutated-model";
  else op.runtimeDescriptor = { kind: "delegated-op", adapter: "codex", sessionId: "session-across-restart" };
  writeOp(op);
}

async function resumeThroughBootstrap(): Promise<never> {
  applyMutation();
  const runtime = selectDurableRuntime();
  const adapter = new ResumeAdapter(runtime.model, runtime.adapter);
  bootstrapCanonicalLoop();
  if (runtime.adapter === "lane-default") setDefaultAdapterForLane("background", () => adapter);
  let dispatcherCalls = 0;
  registerToolDispatcherForOp(opId, {
    async dispatch(call) {
      dispatcherCalls += 1;
      appendFileSync(sideEffectLedger, `${JSON.stringify({
        opId,
        effect: call.tool,
        callId: call.toolCallId,
        replayedBy: "process-b",
      })}\n`);
      return { toolCallId: call.toolCallId, status: "ok", result: { text: "saved" }, durationMs: 1 };
    },
  });
  registerToolsForOp(opId, [{
    name: "write",
    description: "persist the durable file",
    inputSchema: { type: "object", properties: { path: { type: "string" } } },
  }]);

  const deadline = Date.now() + 5_000;
  while (readOp(opId)?.canonical?.state !== "succeeded") {
    const state = readOp(opId)?.canonical?.state;
    if (state === "failed" || Date.now() >= deadline) {
      throw new Error(`restart recovery did not succeed: state=${state}`);
    }
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  await awaitIdle(2_000);
  stopRecoveryJanitor();

  const input = adapter.inputs[0];
  if (!input) throw new Error("replacement adapter was not called");
  const op = readOp(opId);
  const messages = readOpMessages(opId);
  const turns = readOpTurns(opId);
  const sideEffects = readFileSync(sideEffectLedger, "utf8").split("\n").filter(Boolean);
  if (sideEffects.length !== 1) {
    throw new Error(`duplicate committing side effect detected: count=${sideEffects.length}`);
  }
  result({
    state: op?.canonical?.state,
    attemptCount: op?.attemptCount,
    runtimeDescriptor: op?.runtimeDescriptor,
    durableRuntimeSelection: runtime,
    canonicalSessionId: op?.canonical?.sessionId,
    trackedSessionDuringResume: adapter.trackedSessionDuringResume,
    trackedSessionAfterTerminal: getSessionForOp(opId),
    adapterExecutionIdentities: adapter.executionIdentities,
    adapterInputCount: adapter.inputs.length,
    dispatcherCalls,
    resumedTurnIdx: input.turnIdx,
    resumedProviderState: input.providerState,
    resumedToolResults: input.messages.filter(message => message.role === "tool_result").length,
    persistedToolResults: messages.filter(message => message.role === "tool_result").length,
    turnIndexes: turns.map(turn => turn.turnIdx),
    firstTurnToolSummary: turns[0]?.toolCallSummary,
    finalProviderState: turns.at(-1)?.providerState,
    sideEffectCount: sideEffects.length,
    leaseOwner: op?.canonical?.leaseOwner,
    leaseExpiresAt: op?.canonical?.leaseExpiresAt,
  });
}

try {
  if (action === "persist") persistInterruptedOperation();
  if (action === "resume") await resumeThroughBootstrap();
  throw new Error(`unknown restart fixture action: ${action}`);
} catch (error) {
  fail(error);
}
