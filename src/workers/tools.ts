/**
 * Op tools — let the chat agent delegate work to the worker pool.
 *
 *   op_submit    — submit a task to a worker (blocking on result for v1;
 *                  Step 5 will add a non-blocking variant that returns
 *                  the opId immediately so the chat agent can keep talking)
 *   op_status    — inspect an op (active or persisted) by id
 *   op_kill      — terminate a running op immediately
 *   op_redirect  — inject an instruction into a running op (cooperative)
 *   op_list      — list active ops (live ops panel data)
 *
 * Why blocking-first: even the blocking variant gives us the OOM-prevention
 * win immediately. The op runs in a separate Node process with its own
 * heap, so a runaway tool storm can no longer crash the chat agent's
 * server process. The async variant (chat agent stays free during build)
 * is the bigger UX win and lands with Step 5.
 */

import type { ToolDefinition } from "../types.js";
import { submitOp, killOp, redirectOp, getPoolStatus } from "./pool.js";
import { readOp, listOps, newOpId } from "./op-store.js";
import { readEvents } from "./event-log.js";
import { readCheckpoint } from "./checkpoint.js";
import { buildContextPack } from "./context-pack-builder.js";
import { getRetryPolicy } from "./heartbeat.js";
import type { Op, OpLane, OpVisibility } from "./types.js";

export const opSubmitTool: ToolDefinition = {
  name: "op_submit",
  description:
    "Delegate a long-running or heavy task to a worker process. The work runs in an isolated Node process with its own heap — a runaway worker can no longer crash the main agent. Use for: app builds, code refactors, multi-file research, anything you'd otherwise spawn build_app or self_edit for. v1 blocks until the op completes; future version will return opId immediately so you can keep chatting.",
  parameters: {
    type: "object",
    properties: {
      task: { type: "string", description: "Plain-English description of what the worker should do. Be specific — the worker doesn't see your prior conversation unless you pass it via context_files / scope_hint." },
      type: { type: "string", description: "Op type for retry policy + circuit breaker bookkeeping. Examples: 'build_app', 'research_query', 'self_edit', 'refactor'. Default: 'freeform'." },
      success_criteria: { type: "array", items: { type: "string" }, description: "Explicit list of 'you're done when...' conditions. Strongly recommended — tells the worker what to aim for." },
      constraints: { type: "array", items: { type: "string" }, description: "Things the worker must not do (e.g., 'don't touch the auth layer')." },
      not_what_to_redo: { type: "array", items: { type: "string" }, description: "Things that are already done that the worker shouldn't redo (e.g., 'kraken-tradingbot/ already exists, extend it not rebuild')." },
      context_files: { type: "array", items: { type: "string" }, description: "File paths (relative to repo root or absolute) to pre-load into the worker's context. Saves the worker from grepping around." },
      scope_hint: { type: "string", description: "File or directory hint — tells the context pack builder where to walk for AGENTS.md rules and where the work likely happens." },
      memory_query: { type: "string", description: "If set, pre-fetch memory hits matching this query and inject them into the worker's context pack." },
      lane: { type: "string", enum: ["interactive", "build", "background"], description: "Priority lane. interactive = user is waiting, build = user-initiated background, background = cron/idle. Default: 'build'." },
      preferred_provider: { type: "string", description: "Optional provider id to prefer (e.g., 'httpKeyOpenAi', 'cliOauthAnthropic'). Routing falls back to capability matching if unavailable." },
      max_iterations: { type: "number", description: "Cap on agent iterations inside the worker. Default 30." },
      max_wall_time_ms: { type: "number", description: "Hard wall-time cap. Default 900000 (15 min)." },
    },
    required: ["task"],
  },
  async execute(args) {
    const task = String(args.task || "").trim();
    if (!task) return { content: "op_submit requires a 'task' description.", isError: true };

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

    const op: Op = {
      id: newOpId(`op_${opType}`),
      type: opType,
      task,
      contextPack,
      lane,
      retryPolicy: getRetryPolicy(opType),
      ownerId: "local-user", // single-user deployment for now (per spec §16)
      visibility: "private" as OpVisibility,
      status: "pending",
      createdAt: new Date().toISOString(),
      attemptCount: 0,
    };

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

export const opStatusTool: ToolDefinition = {
  name: "op_status",
  description: "Inspect an op by id. Returns status, recent events, and checkpoint. Without an opId, returns the live ops panel summary (active workers + queue length).",
  parameters: {
    type: "object",
    properties: {
      op_id: { type: "string", description: "The opId returned from op_submit. Omit to list active ops." },
      events_tail: { type: "number", description: "How many recent events to include. Default 10." },
    },
  },
  async execute(args) {
    if (!args.op_id) {
      const status = getPoolStatus();
      const all = listOps().slice(0, 10);
      return {
        content:
          `Pool: ${status.workers.length} workers (${status.workers.filter(w => w.busyWith).length} busy), ${status.queueLength} queued.\n\nRecent ops:\n` +
          all.map(o => `  - ${o.id} [${o.status}] ${o.task.slice(0, 80)}`).join("\n"),
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
    properties: { op_id: { type: "string", description: "The opId returned from op_submit." } },
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
      op_id: { type: "string", description: "The opId returned from op_submit." },
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

export const opTools: ToolDefinition[] = [opSubmitTool, opStatusTool, opKillTool, opRedirectTool];
