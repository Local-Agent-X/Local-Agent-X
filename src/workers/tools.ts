/**
 * Op tools — let the chat agent delegate work to the worker pool.
 *
 *   op_submit_async — PRIMARY: fire-and-forget. Returns opId immediately so
 *                     the chat agent can keep responding. The session bridge
 *                     surfaces the result back into the chat session when
 *                     the worker finishes.
 *   op_wait         — Block on a specific opId until it completes (or
 *                     timeout). Use when the agent genuinely needs the
 *                     result before continuing the current turn.
 *   op_submit       — Sugar wrapper = op_submit_async + immediate op_wait.
 *                     Convenient for short ops; for anything heavy, prefer
 *                     op_submit_async so the user isn't stuck waiting.
 *   op_status       — Inspect any op (active or persisted). With no opId,
 *                     lists ops the current session has submitted plus the
 *                     pool/queue summary.
 *   op_kill         — SIGKILL the worker for an op (immediate, per spec §7).
 *   op_redirect     — Inject an instruction into a running op (cooperative).
 *
 * Why async-first: a blocking op_submit holds the chat agent's turn open
 * until the worker finishes. Even if the work itself runs in an isolated
 * subprocess, the user can't chat about anything else until it ends. The
 * async variant is the actual UX unblock that makes the "supervisor + pool"
 * shape feel like a parallel system instead of a sync RPC.
 */

import type { ToolDefinition } from "../types.js";
import { submitOp, killOp, redirectOp, getPoolStatus, awaitOpResult } from "./pool.js";
import { readOp, listOps, newOpId } from "./op-store.js";
import { readEvents } from "./event-log.js";
import { readCheckpoint } from "./checkpoint.js";
import { buildContextPack } from "./context-pack-builder.js";
import { getRetryPolicy } from "./heartbeat.js";
import { trackOpForSession, listOpsForSession } from "./session-bridge.js";
import type { Op, OpLane, OpVisibility } from "./types.js";

// ── Shared op-construction helper ─────────────────────────────────────────

interface SubmitArgs {
  task: string;
  type?: string;
  success_criteria?: string[];
  constraints?: string[];
  not_what_to_redo?: string[];
  context_files?: string[];
  scope_hint?: string;
  memory_query?: string;
  lane?: OpLane;
  preferred_provider?: string;
  max_iterations?: number;
  max_wall_time_ms?: number;
}

async function buildOpFromArgs(rawArgs: Record<string, unknown>): Promise<Op> {
  const args = rawArgs as unknown as SubmitArgs;
  const task = String(args.task || "").trim();
  const opType = String(args.type || "freeform");
  const lane = (typeof args.lane === "string" && ["interactive", "build", "background"].includes(args.lane) ? args.lane : "build") as OpLane;

  const contextPack = await buildContextPack({
    description: task,
    successCriteria: Array.isArray(args.success_criteria) ? args.success_criteria.map(String) : [],
    constraints: Array.isArray(args.constraints) ? args.constraints.map(String) : [],
    notWhatToRedo: Array.isArray(args.not_what_to_redo) ? args.not_what_to_redo.map(String) : [],
    referencedFilePaths: Array.isArray(args.context_files) ? args.context_files.map(String) : [],
    scopeForAgentsRules: typeof args.scope_hint === "string" ? args.scope_hint : undefined,
    memoryQuery: typeof args.memory_query === "string" ? args.memory_query : undefined,
    lane,
    preferredProvider: typeof args.preferred_provider === "string" ? args.preferred_provider : undefined,
    budget: {
      maxIterations: typeof args.max_iterations === "number" ? args.max_iterations : 30,
      maxWallTimeMs: typeof args.max_wall_time_ms === "number" ? args.max_wall_time_ms : 15 * 60 * 1000,
    },
  });

  return {
    id: newOpId(`op_${opType}`),
    type: opType,
    task,
    contextPack,
    lane,
    retryPolicy: getRetryPolicy(opType),
    ownerId: "local-user",
    visibility: "private" as OpVisibility,
    status: "pending",
    createdAt: new Date().toISOString(),
    attemptCount: 0,
  };
}

// Schema reused by both submit variants — same surface, different semantics.
const submitParameters = {
  type: "object",
  properties: {
    task: { type: "string", description: "Plain-English description of what the worker should do. Be specific — the worker doesn't see your prior conversation unless you pass it via context_files / scope_hint." },
    type: { type: "string", description: "Op type for retry policy + circuit breaker bookkeeping. Examples: 'build_app', 'research_query', 'self_edit', 'refactor'. Default: 'freeform'." },
    success_criteria: { type: "array", items: { type: "string" }, description: "Explicit list of 'you're done when...' conditions. Strongly recommended." },
    constraints: { type: "array", items: { type: "string" }, description: "Things the worker must not do." },
    not_what_to_redo: { type: "array", items: { type: "string" }, description: "Things already done that the worker shouldn't redo." },
    context_files: { type: "array", items: { type: "string" }, description: "File paths to pre-load into the worker's context." },
    scope_hint: { type: "string", description: "File or directory hint for AGENTS.md walking + context bootstrapping." },
    memory_query: { type: "string", description: "If set, pre-fetch memory hits matching this query." },
    lane: { type: "string", enum: ["interactive", "build", "background"], description: "Priority lane. Default: 'build'." },
    preferred_provider: { type: "string", description: "Optional provider id (e.g., 'httpKeyOpenAi', 'cliOauthAnthropic')." },
    max_iterations: { type: "number", description: "Cap on agent iterations. Default 30." },
    max_wall_time_ms: { type: "number", description: "Hard wall-time cap. Default 900000 (15 min)." },
  },
  required: ["task"],
};

// ── op_submit_async — primary verb (non-blocking) ─────────────────────────

export const opSubmitAsyncTool: ToolDefinition = {
  name: "op_submit_async",
  description:
    "PREFERRED for any task >5 seconds. Delegates to a worker process and returns the opId IMMEDIATELY — your chat turn does not block. Tell the user 'started, I'll let you know when it's done' and move on. The user is automatically notified when the op completes via a chat update; you can also call op_status(opId) on any future turn. Use op_wait(opId) only if you genuinely need the result before answering the current turn.",
  parameters: submitParameters,
  async execute(args) {
    const task = String(args.task || "").trim();
    if (!task) return { content: "op_submit_async requires a 'task' description.", isError: true };

    const sessionId = String(args._sessionId || "");
    const op = await buildOpFromArgs(args);

    // Track BEFORE submitting so the session bridge can route the eventual
    // completion event even if the worker finishes near-instantly.
    if (sessionId) trackOpForSession(op.id, sessionId);

    // Fire and forget. Errors are surfaced via the session bridge (op result
    // event with status="failed") + persisted to op-store.
    void submitOp(op).catch(() => { /* result already routed via bridge */ });

    return {
      content:
        `op ${op.id} submitted (type=${op.type}, lane=${op.lane}).\n` +
        `Running in background — you can keep responding to the user. ` +
        `The user will see a notification when it completes.\n` +
        `Inspect anytime: op_status(op_id="${op.id}")  |  block on it: op_wait(op_id="${op.id}")`,
    };
  },
};

// ── op_wait — explicit blocking primitive ─────────────────────────────────

export const opWaitTool: ToolDefinition = {
  name: "op_wait",
  description:
    "Block on a specific opId until it completes (or until timeout_ms). Use when you genuinely need the op's result before continuing the current turn — for example, to compose your final answer to the user. Otherwise prefer op_submit_async + tell the user it's running.",
  parameters: {
    type: "object",
    properties: {
      op_id: { type: "string", description: "The opId returned from op_submit_async." },
      timeout_ms: { type: "number", description: "Max wait in ms. Default 1800000 (30 min). Returns a timeout error if exceeded — the op keeps running and you can op_status it later." },
    },
    required: ["op_id"],
  },
  async execute(args) {
    const opId = String(args.op_id || "").trim();
    if (!opId) return { content: "op_wait requires an 'op_id'.", isError: true };

    const timeoutMs = typeof args.timeout_ms === "number" ? args.timeout_ms : 30 * 60 * 1000;
    const startMs = Date.now();
    const result = await awaitOpResult(opId, timeoutMs);
    const wallMs = Date.now() - startMs;

    if (!result) {
      return {
        content: `op ${opId} did not complete within ${Math.round(timeoutMs / 1000)}s. Worker may still be running — call op_status(op_id="${opId}") to check.`,
        isError: true,
      };
    }

    const summary =
      `op ${opId} ${result.status} in ${Math.round(wallMs / 1000)}s` +
      (result.error ? `\n  error: ${result.error.message}` : "") +
      (result.filesChanged.length > 0 ? `\n  files: ${result.filesChanged.slice(0, 5).join(", ")}${result.filesChanged.length > 5 ? "..." : ""}` : "") +
      `\n\n${result.finalSummary}`;

    return { content: summary, isError: result.status !== "completed" };
  },
};

// ── op_submit — sugar wrapper (= async + immediate wait) ──────────────────

export const opSubmitTool: ToolDefinition = {
  name: "op_submit",
  description:
    "Convenience: submit an op AND wait for the result, in one call. Equivalent to op_submit_async + op_wait. ONLY use this for short ops (<10s) where blocking the user is acceptable. For anything heavier — builds, refactors, multi-file research — call op_submit_async instead so you can respond to the user immediately and surface the result via the auto-notification when it's ready.",
  parameters: submitParameters,
  async execute(args) {
    const task = String(args.task || "").trim();
    if (!task) return { content: "op_submit requires a 'task' description.", isError: true };

    const sessionId = String(args._sessionId || "");
    const op = await buildOpFromArgs(args);
    if (sessionId) trackOpForSession(op.id, sessionId);

    const startMs = Date.now();
    const result = await submitOp(op);
    const wallMs = Date.now() - startMs;

    const summary =
      `op ${op.id} ${result.status} in ${Math.round(wallMs / 1000)}s` +
      (result.error ? `\n  error: ${result.error.message}` : "") +
      (result.filesChanged.length > 0 ? `\n  files: ${result.filesChanged.slice(0, 5).join(", ")}${result.filesChanged.length > 5 ? "..." : ""}` : "") +
      `\n\n${result.finalSummary}`;

    return { content: summary, isError: result.status !== "completed" };
  },
};

// ── op_status, op_kill, op_redirect (unchanged behavior) ──────────────────

export const opStatusTool: ToolDefinition = {
  name: "op_status",
  description: "Inspect an op by id. Returns status, recent events, and checkpoint. Without an opId, lists ops you submitted in this session (plus pool / queue summary).",
  parameters: {
    type: "object",
    properties: {
      op_id: { type: "string", description: "The opId returned from op_submit_async / op_submit. Omit to list this session's ops." },
      events_tail: { type: "number", description: "How many recent events to include. Default 10." },
    },
  },
  async execute(args) {
    const sessionId = String(args._sessionId || "");

    if (!args.op_id) {
      const status = getPoolStatus();
      const sessionOpIds = sessionId ? listOpsForSession(sessionId) : [];
      const sessionOpEntries = sessionOpIds
        .map(id => readOp(id))
        .filter((o): o is NonNullable<typeof o> => !!o);
      const recent = sessionOpEntries.length > 0
        ? sessionOpEntries.slice(-10).map(o => `  - ${o.id} [${o.status}] ${o.task.slice(0, 80)}`).join("\n")
        : (listOps().slice(0, 10).map(o => `  - ${o.id} [${o.status}] ${o.task.slice(0, 80)}`).join("\n") || "  (none)");
      return {
        content:
          `Pool: ${status.workers.length} workers (${status.workers.filter(w => w.busyWith).length} busy), ${status.queueLength} queued.\n\n` +
          (sessionOpIds.length > 0 ? `Your ops (this session):\n${recent}` : `Recent ops (all sessions):\n${recent}`),
      };
    }

    const opId = String(args.op_id);
    const op = readOp(opId);
    if (!op) return { content: `op ${opId} not found`, isError: true };

    const events = readEvents(opId).slice(-(typeof args.events_tail === "number" ? args.events_tail : 10));
    const checkpoint = readCheckpoint(opId);

    return {
      content:
        `op ${op.id} [${op.status}]  type=${op.type}  attempts=${op.attemptCount}\n` +
        `task: ${op.task}\n` +
        (checkpoint ? `checkpoint: ${checkpoint.lastSafeBoundary.label} @ ${checkpoint.lastSafeBoundary.timestamp}\n` : "") +
        (op.lastFailureReason ? `last failure: ${op.lastFailureReason}\n` : "") +
        `\nrecent events (${events.length}):\n` +
        events.map(e => `  [${e.type}] ${JSON.stringify(e.payload).slice(0, 120)}`).join("\n"),
    };
  },
};

export const opKillTool: ToolDefinition = {
  name: "op_kill",
  description: "Terminate a running op immediately. Use when the op is going off the rails. The worker is SIGKILL'd; partial side-effects may persist (per spec §7 'Kill is the only immediate control'). For graceful stop, use op_pause (Step 7).",
  parameters: {
    type: "object",
    properties: { op_id: { type: "string", description: "The opId returned from op_submit_async / op_submit." } },
    required: ["op_id"],
  },
  async execute(args) {
    const opId = String(args.op_id);
    const ok = killOp(opId);
    return { content: ok ? `op ${opId} killed` : `op ${opId} not running`, isError: !ok };
  },
};

export const opRedirectTool: ToolDefinition = {
  name: "op_redirect",
  description: "Inject a new instruction into a running op. Cooperative — the worker reads it at the next safe boundary, doesn't interrupt the current step. Use to steer a long-running build mid-flight (e.g., 'also add a stop-loss strategy').",
  parameters: {
    type: "object",
    properties: {
      op_id: { type: "string", description: "The opId returned from op_submit_async / op_submit." },
      instruction: { type: "string", description: "Plain-English instruction to inject into the worker's context." },
    },
    required: ["op_id", "instruction"],
  },
  async execute(args) {
    const opId = String(args.op_id);
    const instruction = String(args.instruction || "").trim();
    if (!instruction) return { content: "op_redirect requires an 'instruction'", isError: true };
    const ok = redirectOp(opId, instruction);
    return {
      content: ok
        ? `Instruction injected into ${opId}. Worker will pick it up at next safe boundary.`
        : `op ${opId} not running`,
      isError: !ok,
    };
  },
};

export const opTools: ToolDefinition[] = [
  opSubmitAsyncTool,  // listed first so registry order matches "preferred" intent
  opWaitTool,
  opSubmitTool,
  opStatusTool,
  opKillTool,
  opRedirectTool,
];
