import { appendFileSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { join } from "node:path";
import { createHash } from "node:crypto";

import {
  appendOpMessage,
  awaitIdle,
  commitTurn,
  readOpMessages,
  readOpTurns,
} from "../../src/canonical-loop/index.js";
import { stopRecoveryJanitor } from "../../src/canonical-loop/recovery-janitor.js";
import { readOp, writeOp } from "../../src/ops/op-store.js";
import { getSessionForOp } from "../../src/ops/session-bridge.js";
import type { Op } from "../../src/ops/types.js";
import { bootstrapCanonicalLoop } from "../../src/server/canonical-loop-bootstrap.js";
import { opTurnPath } from "../../src/canonical-loop/schema.js";
import { sealDelegatedRuntime } from "../../src/canonical-loop/runtime-integrity.js";
import { buildAgentRuntimeSurface } from "../../src/canonical-loop/agent-runner/runtime-surface.js";
import { SecurityLayer } from "../../src/security/index.js";
import { buildToolRegistry } from "../../src/tools.js";
import { writeTool } from "../../src/tools/file-tools.js";
import { setRuntimeConfig } from "../../src/config.js";
import { startAriKernel } from "../../src/ari-kernel/index.js";

const [action, opId, sideEffectLedger, mutation, rawPort] = process.argv.slice(2);
const port = Number(rawPort);
const baseURL = `http://127.0.0.1:${port}/v1`;

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
    routing: { lane: "background", preferredProvider: "local" },
    secrets: { allowed: [] },
  };
}

function exactDescriptor(): NonNullable<Op["runtimeDescriptor"]> {
  const descriptor = {
    kind: "delegated-op",
    adapter: "provider-exact",
    provider: "local",
    credentialProvider: mutation === "cloud-runtime" ? "ollama-cloud" : "local",
    authSource: mutation === "cloud-runtime" ? "env" : "sentinel",
    model: "restart-proof-model",
    runtime: "openai-compat",
    target: mutation === "cloud-runtime"
      ? { kind: "ollama-cloud" as const, endpointFingerprint: createHash("sha256").update(new URL(baseURL).href).digest("hex") }
      : { kind: "local-config" as const, endpointFingerprint: createHash("sha256").update(new URL(baseURL).href).digest("hex") },
    sessionId: "session-across-restart",
    surface: buildAgentRuntimeSurface({
      provider: "local",
      apiKey: "ollama",
      model: "restart-proof-model",
      systemPrompt: "Continue the durable operation from its canonical checkpoint.",
      tools: [writeTool],
      security: new SecurityLayer(process.env.LAX_DATA_DIR!, "unrestricted"),
      callContext: "api",
    }, "session-across-restart"),
  } as const;
  return sealDelegatedRuntime(opId, descriptor);
}

function persistInterruptedOperation(): never {
  setRuntimeConfig({ workspace: process.cwd(), authToken: "restart-test-token", ollamaUrl: baseURL.replace(/\/v1$/, ""), ollamaCloudUrl: baseURL.replace(/\/v1$/, "") } as never);
  buildToolRegistry();
  const task = "resume delegated work after restart";
  const op: Op = {
    id: opId,
    type: "restart-proof",
    task,
    contextPack: contextPack(task),
    lane: "background",
    retryPolicy: { maxRecoveryAttempts: 3, backoffMs: [] },
    runtimeDescriptor: exactDescriptor(),
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
    leaseClaim: { owner: "worker-process-a", generation: 0 },
    turnIdx: 0,
    providerState: {
      adapterName: "openai-compat",
      adapterVersion: "1.0.0",
      providerPayload: { cursor: "checkpoint-0", model: "restart-proof-model" },
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

function applyMutation(): void {
  if (mutation === "replay-from-zero") {
    rmSync(opTurnPath(opId, 0));
    return;
  }
  const op = readOp(opId);
  if (!op) throw new Error("durable operation missing for mutation");
  if (mutation === "wrong-model") op.model = "mutated-model";
  if (mutation === "missing-model" && op.runtimeDescriptor?.kind === "delegated-op") {
    delete (op.runtimeDescriptor as { model?: string }).model;
  }
  if (mutation === "wrong-runtime" && op.runtimeDescriptor?.kind === "delegated-op") {
    (op.runtimeDescriptor as { runtime: string }).runtime = "anthropic";
  }
  if (mutation === "missing-provider" && op.runtimeDescriptor?.kind === "delegated-op") {
    delete (op.runtimeDescriptor as { provider?: string }).provider;
  }
  if (mutation === "wrong-provider" && op.runtimeDescriptor?.kind === "delegated-op") {
    (op.runtimeDescriptor as { provider: string }).provider = "anthropic";
  }
  if (mutation === "missing-runtime" && op.runtimeDescriptor?.kind === "delegated-op") {
    delete (op.runtimeDescriptor as { runtime?: string }).runtime;
  }
  if (mutation === "missing-credential-provider" && op.runtimeDescriptor?.kind === "delegated-op") {
    delete (op.runtimeDescriptor as { credentialProvider?: string }).credentialProvider;
  }
  if (mutation === "wrong-credential-provider" && op.runtimeDescriptor?.kind === "delegated-op") {
    (op.runtimeDescriptor as { credentialProvider: string }).credentialProvider = "xai";
  }
  writeOp(op);
}

interface CapturedRequest { model?: string; messages?: Array<{ role?: string }>; path: string; authorization?: string }

function startProvider(requests: CapturedRequest[]): Promise<Server> {
  let chatRequests = 0;
  const server = createServer((req, res) => {
    if (req.url === "/api/tags") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ models: [{ name: "restart-proof-model" }] }));
      return;
    }
    let raw = "";
    req.setEncoding("utf8");
    req.on("data", chunk => { raw += chunk; });
    req.on("end", () => {
      let body: CapturedRequest = { path: req.url ?? "", authorization: req.headers.authorization };
      try { body = { ...(JSON.parse(raw) as CapturedRequest), path: req.url ?? "", authorization: req.headers.authorization }; } catch { /* expose malformed request below */ }
      requests.push(body);
      const isChatRequest = req.url === "/v1/chat/completions";
      if (isChatRequest) chatRequests += 1;
      res.writeHead(200, { "content-type": "text/event-stream", connection: "close" });
      if (mutation === "replay-from-zero" && isChatRequest && chatRequests === 1) {
        const content = [
          JSON.stringify({ opId, effect: "write", callId: "call-1" }),
          JSON.stringify({ opId, effect: "write", callId: "call-replayed" }),
          "",
        ].join("\n");
        const args = JSON.stringify({ path: sideEffectLedger, content });
        res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: "call-replay", type: "function", function: { name: "write", arguments: args } }] }, finish_reason: null }] })}\n\n`);
        res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] })}\n\n`);
      } else {
        res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: "continued without replay" }, finish_reason: null }] })}\n\n`);
        res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}\n\n`);
      }
      res.end("data: [DONE]\n\n");
    });
  });
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => resolve(server));
  });
}

async function closeProvider(server: Server): Promise<void> {
  server.closeAllConnections?.();
  await new Promise<void>(resolve => server.close(() => resolve()));
}

async function resumeThroughBootstrap(): Promise<never> {
  setRuntimeConfig({ workspace: process.cwd(), authToken: "restart-test-token", ollamaUrl: baseURL.replace(/\/v1$/, ""), ollamaCloudUrl: baseURL.replace(/\/v1$/, "") } as never);
  applyMutation();
  if (mutation === "settings-changed" || mutation === "settings-changed-cloud") {
    writeFileSync(join(process.env.LAX_DATA_DIR!, "settings.json"), JSON.stringify({ provider: "anthropic", model: "mutated-settings-model" }));
  }
  const requests: CapturedRequest[] = [];
  const server = await startProvider(requests);
  if (!(await startAriKernel(join(process.env.LAX_DATA_DIR!, "ari-audit.db"), "workspace-assistant", true))) {
    throw new Error("fixture AriKernel failed to start");
  }
  buildToolRegistry();
  bootstrapCanonicalLoop();

  const deadline = Date.now() + 5_000;
  while (readOp(opId)?.canonical?.state !== "succeeded") {
    const state = readOp(opId)?.canonical?.state;
    if (state === "failed" || Date.now() >= deadline) {
      await closeProvider(server);
      throw new Error(`restart recovery did not succeed: state=${state}; failure=${readOp(opId)?.lastFailureReason ?? "none"}`);
    }
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  await awaitIdle(2_000);
  stopRecoveryJanitor();
  await closeProvider(server);

  const op = readOp(opId);
  const messages = readOpMessages(opId);
  const turns = readOpTurns(opId);
  const sideEffects = readFileSync(sideEffectLedger, "utf8").split("\n").filter(Boolean);
  if (sideEffects.length !== 1) throw new Error(`duplicate committing side effect detected: count=${sideEffects.length}`);
  result({
    state: op?.canonical?.state,
    attemptCount: op?.attemptCount,
    runtimeDescriptor: op?.runtimeDescriptor,
    model: op?.model,
    requestModels: requests.map(request => request.model).filter(Boolean),
    requestPaths: requests.map(request => request.path),
    authorizationHeaders: requests.map(request => request.authorization).filter(Boolean),
    canonicalSessionId: op?.canonical?.sessionId,
    trackedSessionAfterTerminal: getSessionForOp(opId),
    dispatcherCalls: turns.slice(1).reduce((count, turn) => count + (turn.toolCallSummary?.length ?? 0), 0),
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
