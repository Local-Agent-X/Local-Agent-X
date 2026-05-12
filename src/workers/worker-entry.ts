/**
 * Worker process entry point.
 *
 * Spawned by pool.ts as a separate Node process. Receives ops over IPC
 * (stdin = parent→worker, stdout = worker→parent) and runs them. Stays
 * alive across multiple ops (warm worker), exits when parent closes stdin
 * or sends a kill.
 *
 * Step 1 scope: handles ONE op at a time, runs it via canonical-loop
 * (runAgentViaCanonical — same safety stack as chat turns), streams
 * events back. Doesn't yet implement: heartbeats (Step 3), pause/redirect
 * cooperative semantics (Step 7), DAG dep resolution (Step 5).
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
import { looksLikeAgentRefusal } from "../errors/index.js";

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
 * Execute one op end-to-end. Routes through canonical-loop's
 * runAgentViaCanonical so the inner agent turn shares the same safety
 * stack and observability as chat — the context pack is pre-baked into
 * the system prompt and the user message. Streams agent output as
 * worker events. Returns the final OpResult.
 *
 * Note on subprocess context: this file is the entry point for the
 * worker subprocess (spawn'd by pool.ts). canonical-loop initialises
 * fresh inside the subprocess — its bus, scheduler, and middleware
 * stack are per-process singletons. The outer Op id (from assign-op)
 * is the parent-facing identity; runAgentViaCanonical mints a separate
 * inner op id for its own execution scaffold (queued → running →
 * terminal). Both write to ~/.lax/operations/<opId> on disk but only
 * the parent reads the outer op's directory.
 */
async function executeOp(op: Op, signal: AbortSignal): Promise<OpResult> {
  const startMs = Date.now();
  const { runAgentViaCanonical } = await import("../canonical-loop/agent-runner.js");
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

  const result = await runAgentViaCanonical(userMessage, op.contextPack.context.recentTurns, {
    apiKey: resolved.apiKey,
    model: resolved.model,
    provider: resolved.provider as "anthropic" | "codex" | "openai" | "xai" | "gemini" | "local" | "custom",
    systemPrompt,
    tools: allTools,
    security,
    sessionId: `worker-${op.id}`,
    maxIterations: op.contextPack.budget.maxIterations,
    signal,
    opType: "worker_op",
    lane: "background",
    onEvent: (event) => {
      // Forward the agent's stream/tool/done events as worker op events
      try {
        if (event.type === "stream" && "delta" in event) {
          emit({ opId: op.id, type: "agent_text", ts: new Date().toISOString(), payload: { delta: event.delta } });
        } else if (event.type === "tool_start") {
          // payload uses `toolName` (not `tool`) so the session-bridge's
          // onOpEvent handler can read it correctly. Earlier mismatch caused
          // sidebar lines to render as `→ tool` (the fallback string)
          // instead of `→ bash` / `→ read` / etc.
          emit({ opId: op.id, type: "tool_call", ts: new Date().toISOString(), payload: { toolName: event.toolName, tool: event.toolName, args: event.args } });
        } else if (event.type === "tool_end") {
          emit({
            opId: op.id, type: "tool_result", ts: new Date().toISOString(),
            sensitive: event.toolName === "request_secret" || event.toolName === "browser_capture_to_secret",
            payload: { toolName: event.toolName, tool: event.toolName, ok: event.allowed !== false, result: typeof event.result === "string" ? event.result.slice(0, 1000) : event.result },
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

  // Refusal detection: agent ended its turn without calling any tools AND
  // the final text sounds like "I can't do this." Patterns owned by
  // src/errors/classifier.ts via looksLikeAgentRefusal(). Live failure
  // case: a worker whose MCP bridge race-failed got zero filesystem
  // tools, refused with "I don't have access" and was marked `completed`
  // because stopReason was `end_turn`. Catching the refusal flips it to
  // `failed` so narration tells the truth.
  const looksLikeRefusal = toolCallsExecuted === 0 && looksLikeAgentRefusal(lastText);

  // Honest completion sentinels — workers are now told to emit one of:
  //   WORK_DONE: <summary>            → real success
  //   WORK_NEEDS_INPUT: <question>    → can't proceed without user decision
  //   WORK_FAILED: <reason>           → tried recoveries, exhausted
  // A worker that gives up silently no longer slips through as "completed"
  // — the absence of WORK_DONE means we treat the run as inconclusive at
  // best. This is the fix for the "agent gave up but op marked completed"
  // failure mode (e.g. sipdirty805 deploy bailing on `gh repo create`).
  const sentinelDone     = lastText.match(/^\s*WORK_DONE:\s*(.+?)\s*$/m);
  const sentinelNeeds    = lastText.match(/^\s*WORK_NEEDS_INPUT:\s*(.+?)\s*$/m);
  const sentinelFailed   = lastText.match(/^\s*WORK_FAILED:\s*(.+?)\s*$/m);
  if (sentinelNeeds) {
    return {
      opId, status: "needs-input",
      finalSummary: `[needs user input] ${sentinelNeeds[1]}\n\n${trimmedSummary}`.slice(0, 2000),
      filesChanged: [],
      // recoverable: caller can re-spawn with the user's answer prepended.
      error: { message: sentinelNeeds[1], recoverable: true },
    };
  }
  if (sentinelFailed) {
    return {
      opId, status: "failed",
      finalSummary: `[worker failed after retries] ${sentinelFailed[1]}\n\n${trimmedSummary}`.slice(0, 2000),
      filesChanged: [],
      error: { message: sentinelFailed[1], recoverable: false },
    };
  }

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
      // Without a WORK_DONE sentinel and with meaningful work done, mark
      // as "completed" but flag inconclusive so the supervisor can verify.
      // Future: enforce sentinel hard (no-sentinel = failed) once the
      // prompt change has soaked in and most workers comply.
      if (sentinelDone) {
        return { opId, status: "completed", finalSummary: trimmedSummary, filesChanged: [] };
      }
      if (didMeaningfulWork) {
        return {
          opId, status: "completed",
          finalSummary: `[no WORK_DONE sentinel — outcome inconclusive] ${trimmedSummary}`.slice(0, 2000),
          filesChanged: [],
        };
      }
      return {
        opId, status: "failed",
        finalSummary: `[no work done, no WORK_DONE sentinel] ${trimmedSummary}`.slice(0, 2000),
        filesChanged: [],
        error: { message: "Worker exited without producing meaningful work", recoverable: true },
      };

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
    `## Autonomy contract (HARD)`,
    `You exist so the user can step away while you finish their work. Bailing out on the first error wastes their trust. The user is NOT watching — you cannot ask them mid-task. Your job is to make the call and finish.`,
    ``,
    `Recovery rules — when a tool call fails or returns an unexpected result:`,
    `1. READ the error message. Most "errors" are obvious recoverables ("file exists", "name taken", "permission denied", "rate limited", "branch already on remote").`,
    `2. TRY at least 2 alternatives before giving up. Examples:`,
    `   - "repo name already exists" → try \`<name>-2\`, \`<name>-site\`, or push to the existing repo if it's the user's.`,
    `   - "git push rejected" → \`git pull --rebase\` then push, or check if the branch needs \`-f\` (only if it's clearly your own branch).`,
    `   - "directory not empty" → check what's there; rename or merge as appropriate.`,
    `   - "command not found" → check if there's an alternative tool (\`npm\` vs \`pnpm\`, \`python\` vs \`python3\`).`,
    `3. ONLY emit \`WORK_NEEDS_INPUT: <one-sentence question>\` if a decision genuinely requires the user (e.g., "which of your 3 GitHub orgs should I push to?"). Do not use it as a lazy way out.`,
    `4. ONLY emit \`WORK_FAILED: <one-sentence reason>\` if you have exhausted recoveries AND the task is impossible without external action. Include what you tried.`,
    `5. On success, end your final reply with \`WORK_DONE: <one-sentence summary>\` so the supervisor can verify completion honestly. Without this sentinel, the op is presumed inconclusive.`,
    ``,
    `## Tool use rules (HARD CONTRACT)`,
    `- For file edits: ALWAYS use the \`write\` or \`edit\` tools directly. NEVER call \`bash\` to run a Python/sed/awk/heredoc script that writes files. The bash tool returns exit code 0 even when the script silently no-ops, which led to a real bug where this worker reported success after a Python script did nothing. write/edit have no length limit and provide direct verifiable results.`,
    `- After EVERY edit/write call, the tool returns "Edited X" or "Wrote X". If you didn't see those confirmations, the edit didn't happen — don't claim it did.`,
    `- Your final summary MUST list ONLY files that you saw a write/edit confirmation for. Do not list files you intended to change but didn't actually edit.`,
    `- For visual/UI redesigns, you almost always need to touch BOTH the HTML AND the CSS. HTML class-name changes alone don't change appearance. If the task asks for a "new look" or "make it look better", expect to edit styles.css.`,
    `- Memory tools (\`memory_search\`, \`memory_recall\`, \`memory_get\`) are available — USE THEM when the task references past work, the user's preferences, or anything that might be in memory ("deploy like last time", "use the same domain", "same as before"). Don't cold-start what you can recall.`,
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
