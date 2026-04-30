/**
 * Worker process entry point.
 *
 * Spawned by pool.ts as a separate Node process. Receives ops over IPC
 * (stdin = parent→worker, stdout = worker→parent) and runs them. Stays
 * alive across multiple ops (warm worker), exits when parent closes stdin
 * or sends a kill.
 *
 * Step 1 scope: handles ONE op at a time, runs it via runAgent (the same
 * provider abstraction main agent uses), streams events back. Doesn't yet
 * implement: heartbeats (Step 3), pause/redirect cooperative semantics
 * (Step 7), DAG dep resolution (Step 5).
 *
 * Lifecycle:
 *   spawn -> emit 'ready' -> idle -> assign-op -> running -> emit 'result'
 *   -> idle (ready for next op)
 */

import { sendIpc, receiveIpc } from "./ipc.js";
import { ipcEnvelope, type IpcMessage, type Op, type OpEvent, type OpResult } from "./types.js";
import { appendEvent } from "./event-log.js";
import { writeCheckpoint, newCheckpoint } from "./checkpoint.js";
import type { AgentTurn } from "../types.js";
import { randomUUID } from "node:crypto";

// Workers shouldn't write to stdout — that's the IPC channel. Route logs to stderr.
const log = (level: string, msg: string) => process.stderr.write(`[worker ${level}] ${msg}\n`);

const WORKER_ID = `w-${process.pid}-${randomUUID().slice(0, 8)}`;
let currentOp: Op | null = null;
let currentAbortController: AbortController | null = null;

// ── Boot: announce ready ──────────────────────────────────────────────────

sendIpc(process.stdout, ipcEnvelope("ready", {
  workerId: WORKER_ID,
  pid: process.pid,
  capabilities: ["http", "tools"], // expanded over time
}));

// ── Receive loop ──────────────────────────────────────────────────────────

receiveIpc(process.stdin, {
  onMessage: (msg: IpcMessage) => {
    handleMessage(msg).catch(e => log("error", `unhandled in handleMessage: ${(e as Error).message}\n${(e as Error).stack || ""}`));
  },
  onNonIpcLine: (line) => {
    // Stray stdin content from parent — log but don't die
    log("warn", `non-ipc stdin line: ${line.slice(0, 200)}`);
  },
  onError: (e) => {
    log("error", `ipc error: ${e.message}`);
  },
});

// If parent closes stdin, exit cleanly
process.stdin.on("end", () => {
  log("info", "parent closed stdin — exiting");
  process.exit(0);
});

// ── Message dispatch ──────────────────────────────────────────────────────

async function handleMessage(msg: IpcMessage): Promise<void> {
  switch (msg.type) {
    case "assign-op":
      await handleAssignOp(msg.payload.op);
      break;
    case "kill":
      log("info", `kill received (opId=${msg.payload.opId || "worker"})`);
      if (msg.payload.opId && currentOp && msg.payload.opId === currentOp.id) {
        currentAbortController?.abort();
      } else if (!msg.payload.opId) {
        // worker-level kill
        process.exit(0);
      }
      break;
    case "redirect":
      // Cooperative: the running op picks this up at next safe boundary.
      // For step 1 we just log it — pause/redirect machinery is Step 7.
      log("info", `redirect for op ${msg.payload.opId}: ${msg.payload.instruction.slice(0, 100)}`);
      break;
    case "pause":
      log("info", `pause requested for op ${msg.payload.opId} (tier=${msg.payload.tier}) — Step 7 not implemented`);
      break;
    case "ping":
      sendIpc(process.stdout, ipcEnvelope("pong", {
        workerId: WORKER_ID,
        currentOpId: currentOp?.id || null,
        currentPhase: null,
        lastEventTs: null,
        heapMb: Math.round(process.memoryUsage().heapUsed / 1024 / 1024),
        uptimeS: Math.floor(process.uptime()),
      }));
      break;
    default:
      log("warn", `unknown ipc type: ${(msg as { type: string }).type}`);
  }
}

// ── The actual work: run an op ────────────────────────────────────────────

async function handleAssignOp(op: Op): Promise<void> {
  if (currentOp) {
    log("error", `assign-op while busy with ${currentOp.id} — refusing`);
    sendResult({
      opId: op.id,
      status: "failed",
      finalSummary: "Worker was busy when assigned",
      filesChanged: [],
      error: { message: "worker busy", recoverable: true },
    });
    return;
  }

  currentOp = op;
  currentAbortController = new AbortController();

  const checkpoint = newCheckpoint(op.id, op.contextPack.routing.preferredProvider || "auto");
  writeCheckpoint(checkpoint);

  emit({ opId: op.id, type: "started", ts: new Date().toISOString(), payload: { task: op.task } });

  try {
    const result = await executeOp(op, currentAbortController.signal);
    // OpResult.status uses kebab-case ("needs-input"); OpEventType uses snake_case
    // ("needs_input") for consistency with other event types. Map between them.
    const STATUS_TO_EVENT: Record<OpResult["status"], OpEvent["type"]> = {
      completed: "completed",
      failed: "failed",
      cancelled: "cancelled",
      paused: "paused",
      "needs-input": "needs_input",
    };
    emit({ opId: op.id, type: STATUS_TO_EVENT[result.status], ts: new Date().toISOString(), payload: { summary: result.finalSummary } });
    sendResult(result);
  } catch (e) {
    const errMsg = (e as Error).message;
    log("error", `op ${op.id} threw: ${errMsg}`);
    emit({ opId: op.id, type: "failed", ts: new Date().toISOString(), payload: { error: errMsg } });
    sendResult({
      opId: op.id,
      status: "failed",
      finalSummary: `Worker error: ${errMsg}`,
      filesChanged: [],
      error: { message: errMsg, recoverable: false },
    });
  } finally {
    currentOp = null;
    currentAbortController = null;
  }
}

/**
 * Execute one op end-to-end. Routes through runAgent like a normal chat
 * turn, but with the context pack pre-baked into the system prompt and
 * the user message. Streams agent output as events. Returns the final
 * OpResult.
 */
async function executeOp(op: Op, signal: AbortSignal): Promise<OpResult> {
  const startMs = Date.now();
  const { runAgent } = await import("../agent.js");
  const { resolveProvider } = await import("../agent-request.js");
  const { SecurityLayer } = await import("../security.js");
  const { getRuntimeConfig } = await import("../config.js");
  const { extractAgentOutput } = await import("../server-utils.js");
  const { join } = await import("node:path");
  const { homedir } = await import("node:os");

  const runtime = getRuntimeConfig();
  const dataDir = join(homedir(), ".lax");

  // For Step 1: load secrets store + resolve provider, pick the one matching
  // the op's preferredProvider hint or whatever resolveProvider returns by default.
  const { SecretsStore } = await import("../secrets.js");
  const secretsStore = new SecretsStore(dataDir);

  // Map the neutral matrix names → legacy provider names that resolveProvider
  // understands. Lets ops specify preferred_provider in their context pack
  // without depending on the legacy naming.
  const NEUTRAL_TO_LEGACY: Record<string, string> = {
    httpKeyOpenAi: "codex",
    cliOauthAnthropic: "anthropic",
    httpKeyXai: "xai",
    httpKeyGemini: "gemini",
    localHttpOllama: "local",
  };
  const preferredHint = op.contextPack.routing.preferredProvider;
  const providerOverride = preferredHint
    ? (NEUTRAL_TO_LEGACY[preferredHint] || preferredHint)
    : undefined;

  const resolved = await resolveProvider(runtime, secretsStore, dataDir, providerOverride);

  if (!resolved.apiKey) {
    return {
      opId: op.id,
      status: "failed",
      finalSummary: `No API key for provider ${resolved.provider}`,
      filesChanged: [],
      error: { message: "no api key", recoverable: false },
    };
  }

  // Context pack → system prompt + user message
  const systemPrompt = buildSystemPromptFromPack(op);
  const userMessage = op.task;

  // Worker uses workspace-mode security so writes are confined to workspace.
  // Future: per-op worktree (Step 11), like autopilot.
  const security = new SecurityLayer(runtime.workspace || join(dataDir, "workspace"), "common");

  // Tools: bridges-style limited set for Step 1 (read/write/edit/bash/grep/glob/web).
  // The full tool set + per-op filtering is Step 5+.
  const { allTools } = await import("../tools.js");

  emit({ opId: op.id, type: "phase", ts: new Date().toISOString(), payload: { phase: "running-agent", provider: resolved.provider, model: resolved.model } });

  const result = await runAgent(userMessage, op.contextPack.context.recentTurns, {
    apiKey: resolved.apiKey,
    model: resolved.model,
    provider: resolved.provider as "anthropic" | "codex" | "openai" | "xai" | "gemini" | "local" | "custom",
    systemPrompt,
    tools: allTools,
    security,
    sessionId: `worker-${op.id}`,
    maxIterations: op.contextPack.budget.maxIterations,
    signal,
    onEvent: (event) => {
      // Forward the agent's stream/tool/done events as worker op events
      try {
        if (event.type === "stream") {
          emit({ opId: op.id, type: "agent_text", ts: new Date().toISOString(), payload: { delta: event.delta } });
        } else if (event.type === "tool_start") {
          emit({ opId: op.id, type: "tool_call", ts: new Date().toISOString(), payload: { tool: event.toolName, args: event.args } });
        } else if (event.type === "tool_end") {
          emit({
            opId: op.id, type: "tool_result", ts: new Date().toISOString(),
            sensitive: event.toolName === "request_secret" || event.toolName === "browser_capture_to_secret",
            payload: { tool: event.toolName, ok: event.allowed !== false, result: typeof event.result === "string" ? event.result.slice(0, 1000) : event.result },
          });
        }
      } catch (e) { log("warn", `event forward failed: ${(e as Error).message}`); }
    },
  });

  // Checkpoint at completion
  writeCheckpoint({
    ...newCheckpoint(op.id, resolved.provider),
    completedSteps: 1,
    lastSafeBoundary: { label: "op-completed", timestamp: new Date().toISOString() },
  });

  const finalSummary = extractAgentOutput(result.messages) || "(no output)";
  log("info", `op ${op.id} done in ${Math.round((Date.now() - startMs) / 1000)}s, stopReason=${result.stopReason}`);

  return classifyOpResult(op.id, result, signal, finalSummary);
}

/**
 * Translate runAgent's stopReason + abort state into an OpResult status.
 *
 * The naive `stopReason === "error" ? failed : completed` lost real work:
 * an agent that wrote files then errored on the final iteration was reported
 * as "failed" with no signal that work landed. Classify by evidence — any
 * tool calls executed or meaningful final text means progress was made,
 * regardless of the terminal stopReason.
 */
function classifyOpResult(
  opId: string,
  result: AgentTurn,
  signal: AbortSignal,
  finalSummary: string,
): OpResult {
  const trimmedSummary = finalSummary.slice(0, 2000);

  if (signal.aborted) {
    return { opId, status: "cancelled", finalSummary: trimmedSummary, filesChanged: [] };
  }

  const toolCallsExecuted = result.messages.filter(m => m.role === "tool").length;
  const lastAssistant = [...result.messages].reverse().find(m => m.role === "assistant");
  const lastText = typeof lastAssistant?.content === "string"
    ? lastAssistant.content
    : Array.isArray(lastAssistant?.content)
      ? lastAssistant.content
          .filter((c): c is { type: "text"; text: string } => typeof c === "object" && c !== null && "type" in c && (c as { type: string }).type === "text")
          .map(c => c.text)
          .join("")
      : "";
  const didMeaningfulWork = toolCallsExecuted > 0 || lastText.trim().length > 20;

  // Refusal patterns: agent ended its turn without calling any tools AND the
  // final text sounds like "I can't do this." Live failure mode: a worker
  // whose Anthropic CLI MCP bridge race-failed got zero filesystem tools,
  // refused with "I don't have the file system tools (Read, Edit, ...)
  // available — please re-run", and was marked `completed` because
  // stopReason was `end_turn`. The supervisor then narrated it to the user
  // as success. Catch the refusal and label it `failed` so narration tells
  // the truth.
  const REFUSAL_PATTERNS = [
    /\bI (don't|do not) have (the |access to |any )?\w*\s*(file ?system|filesystem|standard)?\s*(tools?|access)/i,
    /\bI (can't|cannot|am unable to|am not able to|don't have a way to)\s+(audit|refactor|edit|read|modify|access|complete|do this)/i,
    /\bno (filesystem|tool|MCP|standard)\s+(access|tools?)\s+(available|exposed|enabled)/i,
    /\b(could|can|please) you (re-?run|provide|share|paste|enable)/i,
    /\bplease (re-?run|provide|share|paste|enable)\s+(this|the file|tools|file contents)/i,
  ];
  const looksLikeRefusal = toolCallsExecuted === 0 && REFUSAL_PATTERNS.some(rx => rx.test(lastText));

  switch (result.stopReason) {
    case "end_turn":
      if (looksLikeRefusal) {
        return {
          opId, status: "failed",
          finalSummary: `[worker refused — likely tool-access issue] ${trimmedSummary}`.slice(0, 2000),
          filesChanged: [],
          error: { message: "Worker refused or couldn't proceed (likely missing tool access)", recoverable: true },
        };
      }
      return { opId, status: "completed", finalSummary: trimmedSummary, filesChanged: [] };

    case "abort":
      return { opId, status: "cancelled", finalSummary: trimmedSummary, filesChanged: [] };

    case "max_iterations":
      return didMeaningfulWork
        ? { opId, status: "completed", finalSummary: `[hit max iterations] ${trimmedSummary}`.slice(0, 2000), filesChanged: [] }
        : { opId, status: "failed", finalSummary: "Hit max iterations without making progress", filesChanged: [], error: { message: "max_iterations with no work done", recoverable: true } };

    case "error":
      return didMeaningfulWork
        ? { opId, status: "completed", finalSummary: `[late error: ${result.errorMessage || "unknown"}] ${trimmedSummary}`.slice(0, 2000), filesChanged: [] }
        : { opId, status: "failed", finalSummary: result.errorMessage || "Agent errored without making progress", filesChanged: [], error: { message: result.errorMessage || "unknown error", recoverable: true } };

    default:
      return { opId, status: "failed", finalSummary: trimmedSummary, filesChanged: [], error: { message: `unknown stopReason: ${result.stopReason}`, recoverable: false } };
  }
}

function buildSystemPromptFromPack(op: Op): string {
  const p = op.contextPack;
  const blocks: string[] = [
    `You are a worker sub-agent for Local Agent X. Execute the assigned task and return a result. The supervisor (main agent) is the user-facing voice; you are the muscle.`,
    ``,
    `## Task`,
    p.task.description,
  ];

  if (p.task.successCriteria.length > 0) {
    blocks.push(``, `## Success criteria`, ...p.task.successCriteria.map(s => `- ${s}`));
  }
  if (p.task.constraints.length > 0) {
    blocks.push(``, `## Constraints`, ...p.task.constraints.map(s => `- ${s}`));
  }
  if (p.task.notWhatToRedo.length > 0) {
    blocks.push(``, `## Do NOT redo`, ...p.task.notWhatToRedo.map(s => `- ${s}`));
  }
  if (p.context.referencedFiles.length > 0) {
    blocks.push(``, `## Referenced files (pre-loaded)`);
    for (const f of p.context.referencedFiles) {
      blocks.push(`### ${f.path}${f.truncated ? " (truncated)" : ""}\n\`\`\`\n${f.content.slice(0, 3000)}\n\`\`\``);
    }
  }
  if (p.context.memoryHits.length > 0) {
    blocks.push(``, `## Relevant memory`, ...p.context.memoryHits.map(m => `- (${m.source}) ${m.snippet}`));
  }
  if (p.context.agentsRules.trim()) {
    blocks.push(``, `## Architectural rules (follow strictly)`, p.context.agentsRules);
  }
  if (p.secrets.allowed.length > 0) {
    blocks.push(``, `## Secrets you may request`, p.secrets.allowed.join(", "), `(use the request_secret tool to fetch values; never type secrets in plain text)`);
  }
  return blocks.join("\n");
}

// ── Helpers ────────────────────────────────────────────────────────────────

function emit(event: OpEvent): void {
  // Disk-append (with redaction) AND IPC-send to parent
  appendEvent(event);
  sendIpc(process.stdout, ipcEnvelope("event", { event }));
}

function sendResult(result: OpResult): void {
  sendIpc(process.stdout, ipcEnvelope("result", { result }));
}
