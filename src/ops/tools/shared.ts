/**
 * Shared helpers + state for the op-tool modules.
 *
 * The dedup maps (RECENT_SUBMITS, RECENT_POLLS) live here because they are
 * cross-tool: op_submit_async writes RECENT_SUBMITS; op_status reads/writes
 * RECENT_POLLS. Keeping them in shared state preserves the original
 * single-module semantics now that the tools live in separate files.
 */

import { getOrInitSecretsStore, normalizeSecretName } from "../../secrets.js";
import { getRuntimeConfig } from "../../config.js";
import { getLaxDir } from "../../lax-data-dir.js";
import { resolveCredential } from "../../auth/resolve.js";
import { resolveProvider } from "../../agent-request/resolve-provider.js";
import {
  registerAdapterForOp,
  createProviderAdapterFactory,
  resolveProviderRuntime,
  sealDelegatedRuntime,
} from "../../canonical-loop/public/delegated-runtime.js";
import { buildContextPack } from "../context-pack-builder.js";
import { getRetryPolicy } from "../heartbeat.js";
import { newOpId, readOp, isInteractiveHostOpType } from "../op-store.js";
import { readRecentSessionMessages, listOpsForSession } from "../session-bridge.js";
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
  pre_blessed_secrets?: string[];
}

/**
 * Resolve and pin the exact provider/model/runtime before persistence, then
 * install the matching per-op factory. Recovery can rebuild this identity
 * without consulting whatever provider settings happen to exist later.
 */
export async function configureDelegatedRuntime(
  op: Op,
  sessionId: string,
): Promise<void> {
  if (!sessionId) throw new Error("delegated runtime session id is required");
  const dataDir = getLaxDir();
  const resolved = await resolveProvider(
    getRuntimeConfig(),
    getOrInitSecretsStore(dataDir),
    dataDir,
    op.contextPack.routing.preferredProvider,
  );
  const runtime = await resolveProviderRuntime(resolved.provider as import("../../providers/provider-ids.js").ProviderId, resolved.model, {
    apiKey: resolved.apiKey,
    authSource: resolved.authSource ?? (() => { throw new Error("provider credential source was not resolved"); })(),
    customBaseURL: resolved.customBaseURL,
  });
  let authSource = runtime.identity.authSource;
  let apiKey = runtime.apiKey;
  if (runtime.identity.credentialProvider !== resolved.provider) {
    const credential = await resolveCredential(runtime.identity.credentialProvider);
    if (!credential || credential.credential !== runtime.apiKey) throw new Error("resolved runtime credential does not match its canonical credential source");
    authSource = credential.source;
    apiKey = credential.credential;
  }
  op.runtimeDescriptor = sealDelegatedRuntime(op.id, {
    kind: "delegated-op",
    adapter: "provider-exact",
    ...runtime.identity,
    authSource,
    sessionId,
  });
  op.model = runtime.identity.model;
  const factory = await createProviderAdapterFactory(op.runtimeDescriptor, {
    apiKey,
    authSource,
    customBaseURL: resolved.customBaseURL,
    sessionId: sessionId || undefined,
  });
  registerAdapterForOp(op.id, factory);
}

/** Every recoverable delegated op needs a durable session identity, including
 * unattended submissions that have no originating chat session. */
export function delegatedRuntimeSessionId(opId: string, originatingSessionId: string): string {
  return originatingSessionId || opId;
}

/**
 * Spawn-lineage parent for an op being submitted: the id of the op whose agent
 * is executing this submit tool. Recovered from the executor-stamped
 * `_sessionId` (resolve-tool.ts injectSessionState) — the live interactive-host
 * op (chat_turn / voice_turn) for that session IS the tool-calling turn that
 * just invoked op_submit (op-store.isInteractiveHostOpType; the same identity
 * the self-block guard keys on in op-submit-async.ts). The executing op's id is
 * NOT threaded into the tool args at this seam — it lives only in the canonical
 * ToolDispatcher closure (chat-tool-dispatcher.ts `opId`), which is outside this
 * footprint — so worker→worker spawns (no live host op in the session) return
 * undefined here. parentOpId stays strictly optional, so absence is a no-op.
 */
function resolveParentOpId(sessionId: string): string | undefined {
  if (!sessionId) return undefined;
  for (const id of listOpsForSession(sessionId)) {
    const op = readOp(id);
    if (op && (op.status === "running" || op.status === "pending") && isInteractiveHostOpType(op.type)) {
      return op.id;
    }
  }
  return undefined;
}

export async function buildOpFromArgs(rawArgs: Record<string, unknown>): Promise<Op> {
  const args = rawArgs as unknown as SubmitArgs;
  const task = String(args.task || "").trim();
  const opType = String(args.type || "freeform");
  const lane = (typeof args.lane === "string" && ["interactive", "build", "background"].includes(args.lane) ? args.lane : "build") as OpLane;

  // Context relay: seed the worker with the originating session's recent turns
  // so a terse task ("set up an agent") is read against what the user actually
  // discussed, not in a vacuum. The agent's curated fields (success_criteria,
  // constraints, context_files) still take precedence; this is the safety net
  // for when the agent under-specifies the handoff.
  const sessionId = typeof rawArgs._sessionId === "string" ? rawArgs._sessionId : "";
  const parentSessionMessages = sessionId ? readRecentSessionMessages(sessionId) : [];

  // Spawn lineage: stamp the op whose agent is executing this submit tool (the
  // spawning turn) onto the new op, so the agents panel can later render a
  // run-lineage tree. Resolved from `_sessionId`; undefined when unavailable.
  const parentOpId = resolveParentOpId(sessionId);
  const preferredProvider = typeof args.preferred_provider === "string"
    ? args.preferred_provider
    : undefined;

  const contextPack = await buildContextPack({
    description: task,
    parentSessionMessages,
    successCriteria: Array.isArray(args.success_criteria) ? args.success_criteria.map(String) : [],
    constraints: Array.isArray(args.constraints) ? args.constraints.map(String) : [],
    notWhatToRedo: Array.isArray(args.not_what_to_redo) ? args.not_what_to_redo.map(String) : [],
    referencedFilePaths: Array.isArray(args.context_files) ? args.context_files.map(String) : [],
    scopeForAgentsRules: typeof args.scope_hint === "string" ? args.scope_hint : undefined,
    memoryQuery: typeof args.memory_query === "string" ? args.memory_query : undefined,
    lane,
    preferredProvider,
    budget: {
      maxIterations: typeof args.max_iterations === "number" ? args.max_iterations : 30,
      maxWallTimeMs: typeof args.max_wall_time_ms === "number" ? args.max_wall_time_ms : 15 * 60 * 1000,
    },
  });

  // Pre-blessed secrets: the user authorizes specific secret NAMES for auto-fill
  // during this op (browser_fill_from_secret skips first-use approval while the
  // op runs). Normalize through the canonical helper so the names match exactly
  // what the fill gate looks up — see ops/pre-bless.ts. Names only, never values.
  const preBlessed = Array.isArray(args.pre_blessed_secrets)
    ? Array.from(new Set(args.pre_blessed_secrets.map((n) => normalizeSecretName(String(n))).filter(Boolean)))
    : [];
  if (preBlessed.length) contextPack.secrets.preBlessed = preBlessed;

  return {
    id: newOpId(`op_${opType}`),
    ...(sessionId ? { sessionId } : {}),
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
    ...(parentOpId ? { parentOpId } : {}),
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
    pre_blessed_secrets: { type: "array", items: { type: "string" }, description: "Secret NAMES (SCREAMING_SNAKE_CASE, already in the vault) the USER has explicitly authorized this op to auto-fill into login forms without stopping for first-use approval. ONLY set this when the user told you to pre-approve them — it lets browser_fill_from_secret fill these names while the op runs. Origin binding still applies (a secret only fills on its own recorded site) and the value never passes through you. Leave empty otherwise." },
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
