/**
 * Shared helpers + state for the op-tool modules.
 *
 * The dedup maps (RECENT_SUBMITS, RECENT_POLLS) live here because they are
 * cross-tool: op_submit_async writes RECENT_SUBMITS; op_status reads/writes
 * RECENT_POLLS. Keeping them in shared state preserves the original
 * single-module semantics now that the tools live in separate files.
 */

import { existsSync, readFileSync } from "node:fs";
import { getLaxDir } from "../../lax-data-dir.js";
import { join } from "node:path";
import { buildContextPack } from "../context-pack-builder.js";
import { getRetryPolicy } from "../heartbeat.js";
import { newOpId } from "../op-store.js";
import type { Op, OpLane, OpVisibility } from "../types.js";

export interface SubmitArgs {
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

/**
 * Read the user's currently-selected provider from ~/.lax/settings.json.
 * Used to pick the canonical adapter for ops that don't carry an explicit
 * provider hint. Same source as the chat resolver, so adapter selection
 * stays consistent with what the rest of the app shows.
 */
export async function readSettingsProvider(): Promise<string | null> {
  try {
    const sp = join(getLaxDir(), "settings.json");
    if (!existsSync(sp)) return null;
    const s = JSON.parse(readFileSync(sp, "utf-8"));
    return typeof s.provider === "string" ? s.provider : null;
  } catch {
    return null;
  }
}

export async function buildOpFromArgs(rawArgs: Record<string, unknown>): Promise<Op> {
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
export const submitParameters = {
  type: "object",
  properties: {
    task: { type: "string", description: "Plain-English description of what the worker should do. CRITICAL: the worker does NOT see the chat thread — only this `task` string + `context_files` / `scope_hint` / `memory_query`. If the user referred to anything earlier in the conversation (a specific service, handle, business name, file path, prior decision, etc.), you MUST repeat it here verbatim or the worker will guess wrong. Example: user said 'Instagram for @theirhandle' three turns ago, then 'connect my store account' now — the task must include 'Instagram, @theirhandle', not just 'connect my account'." },
    type: { type: "string", description: "Op type for retry policy + circuit breaker bookkeeping. Examples: 'build_app', 'research_query', 'self_edit', 'refactor'. Default: 'freeform'." },
    success_criteria: { type: "array", items: { type: "string" }, description: "Explicit list of 'you're done when...' conditions. Strongly recommended." },
    constraints: { type: "array", items: { type: "string" }, description: "Things the worker must not do." },
    not_what_to_redo: { type: "array", items: { type: "string" }, description: "Things already done that the worker shouldn't redo." },
    context_files: { type: "array", items: { type: "string" }, description: "File paths to pre-load into the worker's context." },
    scope_hint: { type: "string", description: "File or directory hint for AGENTS.md walking + context bootstrapping." },
    memory_query: { type: "string", description: "If set, pre-fetch memory hits matching this query." },
    lane: { type: "string", enum: ["interactive", "build", "background"], description: "Which lane to schedule on. CHOOSE EXPLICITLY — do not omit. interactive: pure reasoning, Q&A, summarization, research synthesis, status checks, planning, reviewing, explaining, non-mutating analysis (the worker does NOT touch files, run builds, or change repo state). build: code edits, app builds, file writes, repo changes, long implementation, shell/test work, anything that mutates the workspace. background: scheduled / low-priority recurring jobs. If unsure, prefer 'interactive' for any read-only / advisory task and 'build' for any task that produces or modifies artifacts. Fallback when omitted is 'build' for safety, but you should still pick explicitly." },
    preferred_provider: { type: "string", description: "Optional provider id (e.g., 'httpKeyOpenAi', 'cliOauthAnthropic')." },
    max_iterations: { type: "number", description: "Cap on agent iterations. Default 30." },
    max_wall_time_ms: { type: "number", description: "Hard wall-time cap. Default 900000 (15 min)." },
  },
  required: ["task"],
};

// Per-session dedup window. Anthropic's MCP-bridge tool loop (and to a lesser
// extent every model under tool-use pressure) sometimes re-asserts a delegation
// 3-5 times in one turn — usually with slightly different task phrasing each
// time, so a per-task-string dedup misses them. We dedup at the SESSION level:
// one op_submit_async per session per window, period. If the supervisor needs
// truly-parallel ops, it can submit again after the window or after the prior
// op completes. 30s comfortably covers one chat turn end-to-end.
export const RECENT_SUBMITS = new Map<string, { opId: string; ts: number; task: string }>();
export const SUBMIT_DEDUP_WINDOW_MS = 30_000;

// Polling-loop guard for op_status / op_wait. The chat agent kept calling
// op_status on the same op_id 16 times in one turn waiting for a long-running
// op to finish. Track per-session calls per op_id within a short window; after
// the second call return a STOP-polling message that ends the turn.
export const RECENT_POLLS = new Map<string, { opId: string; tool: string; count: number; firstAt: number; lastAt: number }>();
export const POLL_LOOP_WINDOW_MS = 60_000;
export const POLL_LOOP_MAX = 1; // first call returns rich data; second call returns STOP
