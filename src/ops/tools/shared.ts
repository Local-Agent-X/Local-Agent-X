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
  buildAgentRuntimeSurface,
  installOpToolRuntime,
} from "../../canonical-loop/public/delegated-runtime.js";
import { SecurityLayer } from "../../security/index.js";
import { loadFileAccessModeAtLeast } from "../../security/layer/index.js";
import { loadToolPolicy } from "../../tool-policy/index.js";
import { delegatedWorkerPrompt } from "../../server/background-jobs/prompts.js";
import { buildContextPack } from "../context-pack-builder.js";
import { getRetryPolicy } from "../heartbeat.js";
import { newOpId } from "../op-store.js";
import { delegationFrom } from "../delegation.js";
import { broadcastToSession, readRecentSessionMessages } from "../session-bridge.js";
import { delegatedToolsetForOp } from "./delegated-toolset.js";
import { resolveSubmittedWorkRoot } from "./work-root.js";
import { clearSessionWorkRoot, resolveAgentPath, setSessionWorkRoot } from "../../workspace/paths.js";
import { operationIdOf, sessionIdOf } from "../../tool-execution/internal-args.js";
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
  work_root?: string;
  preferred_provider?: string;
  max_iterations?: number;
  max_wall_time_ms?: number;
  pre_blessed_secrets?: string[];
  depends_on?: string[];
}

/**
 * Resolve and pin the exact provider/model/runtime before persistence, then
 * install the matching per-op factory. Recovery can rebuild this identity
 * without consulting whatever provider settings happen to exist later.
 *
 * Two session ids, deliberately: the worker's TOOL RUNTIME runs under its
 * own op id — its allowed paths, work root, `_sessionId` stamp, approvals,
 * taint and trash scope are keyed there — while `parentSessionId` (the
 * submitting conversation, "" when unattended) is where progress routes and
 * what the op record binds to. Registering a build worker's work root under
 * the parent's id would re-anchor the parent chat's own file tools for the
 * worker's lifetime; app-build ops (tools/build-app-runtime.ts) split the
 * ids the same way. canonical-loop/delegated-session-lineage.ts carries what
 * must still cross between them (browser ownership, lineage at terminal).
 */
export async function configureDelegatedRuntime(
  op: Op,
  parentSessionId: string,
): Promise<void> {
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
  // Real toolset + durable surface for the delegated worker. The surface is
  // INSIDE the descriptor MAC, so it must be attached before the single seal —
  // recovery (createRecoveredAdapterFactory → rehydrateAgentRuntimeSurface)
  // rebuilds tools/dispatcher from it after a restart or in a process worker.
  // "agent"-lane ops (none reach this path today) fall back to the read-only
  // interactive belt rather than failing the submission.
  const workRoot = op.contextPack.routing.workRoot;
  const tools = delegatedToolsetForOp(
    op.lane === "build" ? "build" : op.lane === "background" ? "background" : "interactive",
    { workRoot },
  );
  const systemPrompt = delegatedWorkerPrompt(workRoot);
  // Same construction recovery performs: a fresh SecurityLayer over the
  // configured workspace (file-access honors the user's global setting,
  // floored at "workspace" — the cron background-job posture) and the live
  // on-disk tool policy.
  const security = new SecurityLayer(getRuntimeConfig().workspace, loadFileAccessModeAtLeast("workspace"));
  const toolPolicy = loadToolPolicy(dataDir);
  // The build lane's mutation scope, registered BEFORE the surface is built
  // so recovery restores both (runtimeIdentity captures the allowed path,
  // the surface the work root). Keyed by the worker's own session (op.id):
  // the allowed path dies with this SecurityLayer instance, the work root is
  // cleared at terminal (state-machine.ts finalizeTerminalState).
  if (workRoot) {
    security.addAllowedPath(workRoot, op.id);
    setSessionWorkRoot(op.id, workRoot);
  }
  const surfaceOptions = {
    systemPrompt,
    tools,
    security,
    toolPolicy,
    callContext: "delegated" as const,
  };
  try {
    op.runtimeDescriptor = sealDelegatedRuntime(op.id, {
      kind: "delegated-op",
      adapter: "provider-exact",
      ...runtime.identity,
      authSource,
      sessionId: op.id,
      ...(parentSessionId ? { parentSessionId } : {}),
      surface: buildAgentRuntimeSurface(surfaceOptions, op.id),
    });
    op.model = runtime.identity.model;
    // buildOpFromArgs built the pack before the credential was known. Stamp the
    // resolved source now: cost-recording.ts books the ledger row under it and
    // checkpoint-stop.ts judges the spend ceiling by it (undefined bills as real
    // spend). src/ops/context-pack-auth-source.test.ts pins this stamp.
    op.contextPack.routing.authSource = authSource;
    const factory = await createProviderAdapterFactory(op.runtimeDescriptor, {
      apiKey,
      authSource,
      customBaseURL: resolved.customBaseURL,
      sessionId: op.id,
      systemPrompt,
      // Recovery derives this from surface.kind === "agent-runner"; set it here
      // too so first-run and recovered turns force tools identically.
      requireToolOnFirstTurn: true,
    });
    registerAdapterForOp(op.id, factory);
    // First-run in-process registration: dispatcher + tool list are live
    // immediately (recovery rehydrates the same runtime from the surface).
    const ownerSessionId = delegatedOwnerSessionId(op.id, parentSessionId);
    installOpToolRuntime(op, {
      tools,
      security,
      toolPolicy,
      sessionId: op.id,
      ...(parentSessionId ? { parentSessionId } : {}),
      callContext: "delegated",
      onEvent: event => broadcastToSession(ownerSessionId, event),
    });
  } catch (e) {
    if (workRoot) clearSessionWorkRoot(op.id);
    throw e;
  }
}

/** The session an op's record binds to (`canonical.sessionId`, the session
 * bridge, the cost ledger): the submitting conversation, or the op's own id
 * for an unattended submission. NOT the worker's tool-runtime session — that
 * is always op.id (configureDelegatedRuntime). */
export function delegatedOwnerSessionId(opId: string, originatingSessionId: string): string {
  return originatingSessionId || opId;
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
  const sessionId = sessionIdOf(rawArgs) ?? "";
  const parentSessionMessages = sessionId ? readRecentSessionMessages(sessionId) : [];

  // The task is the calling agent's own words: stamp the op that wrote it (the
  // agents panel's run-lineage tree) and the user's bans recorded on that op,
  // which the worker inherits instead of mining this text for them.
  const callerOpId = operationIdOf(rawArgs);
  const { parentOpId, inheritedConstraints } = delegationFrom(sessionId, callerOpId);
  const preferredProvider = typeof args.preferred_provider === "string"
    ? args.preferred_provider
    : undefined;
  // Vetted before the pack is built so a refused build submission costs
  // nothing (no AGENTS.md walk, no memory search). Throws WorkRootRefused.
  const workRoot = resolveSubmittedWorkRoot(args.work_root, lane, sessionId || undefined);

  const contextPack = await buildContextPack({
    description: task,
    parentSessionMessages,
    successCriteria: Array.isArray(args.success_criteria) ? args.success_criteria.map(String) : [],
    constraints: Array.isArray(args.constraints) ? args.constraints.map(String) : [],
    notWhatToRedo: Array.isArray(args.not_what_to_redo) ? args.not_what_to_redo.map(String) : [],
    // Resolved as the file-access gate resolved them (a relative path anchors
    // at the workspace or the session's work root), so the files the pack
    // reads are the files the gate checked.
    referencedFilePaths: Array.isArray(args.context_files) ? args.context_files.map((p) => resolveAgentPath(String(p), sessionId || undefined)) : [],
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
  // Durable on the op record: configureDelegatedRuntime registers it, the
  // belt chooser and augmentation denylist read it, and the AGENTS panel can
  // show where the worker was allowed to write.
  if (workRoot) contextPack.routing.workRoot = workRoot;

  return {
    id: newOpId(`op_${opType}`),
    ...(sessionId ? { sessionId } : {}),
    type: opType,
    task,
    taskProvenance: "agent",
    inheritedConstraints,
    contextPack,
    lane,
    retryPolicy: getRetryPolicy(opType),
    ownerId: "local-user",
    visibility: "private" as OpVisibility,
    status: "pending",
    createdAt: new Date().toISOString(),
    attemptCount: 0,
    ...(parentOpId ? { parentOpId } : {}),
    ...(Array.isArray(args.depends_on) ? { dependsOn: args.depends_on.map(String) } : {}),
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
    lane: { type: "string", enum: ["interactive", "build", "background"], description: "Which lane to schedule on. CHOOSE EXPLICITLY — do not omit. interactive: pure reasoning, Q&A, summarization, research synthesis, status checks, planning, reviewing, explaining, non-mutating analysis — the worker gets read/search/web tools only and can NOT write files or run commands. build: code edits, app builds, file writes, refactors, shell/test work, anything that mutates files — the worker gets write/edit/multi_edit/edit_lines/delete_file/restore_file and bash, confined to `work_root` (name the project folder; omitted = your own work root, else the whole workspace). background: scheduled / low-priority recurring jobs (read-only belt). If unsure, prefer 'interactive' for any read-only / advisory task and 'build' (with work_root) for any task that produces or modifies files. Fallback when omitted is 'build'." },
    work_root: { type: "string", description: "Build lane: the ONE existing directory the worker may write to and run commands in — e.g. 'apps/<name>' (workspace-relative) or an absolute path. Name the project folder so the worker cannot touch anything else; omitted, the worker gets your own work root (an IDE / project session), else the whole workspace. Must be inside the workspace (or inside your own project root when you have one); anything else is refused. The worker's relative paths and its bash cwd anchor here, and writes outside it are blocked. Ignored on the other lanes." },
    preferred_provider: { type: "string", description: "Optional provider id (e.g., 'httpKeyOpenAi', 'cliOauthAnthropic')." },
    max_iterations: { type: "number", description: "Cap on agent iterations. Default 30." },
    max_wall_time_ms: { type: "number", description: "Hard wall-time cap. Default 900000 (15 min)." },
    pre_blessed_secrets: { type: "array", items: { type: "string" }, description: "Secret NAMES (SCREAMING_SNAKE_CASE, already in the vault) the USER has explicitly authorized this op to auto-fill into login forms without stopping for first-use approval. ONLY set this when the user told you to pre-approve them — it lets browser_fill_from_secret fill these names while the op runs. Origin binding still applies (a secret only fills on its own recorded site) and the value never passes through you. Leave empty otherwise." },
    depends_on: { type: "array", items: { type: "string" }, description: "Existing canonical op ids that must succeed before this op may consume a worker slot. Failed or cancelled prerequisites propagate without a new permission prompt." },
  },
  required: ["task"],
};

// Same-task dedup window. Anthropic's MCP-bridge tool loop (and to a lesser
// extent every model under tool-use pressure) sometimes re-asserts a delegation
// 3-5 times in one turn, usually rephrased a little each time. A submission
// that is a near-duplicate of one this session made inside the window gets
// the existing opId back instead of a second worker; a DIFFERENT task from
// the same session is parallel fan-out and goes through. (While the first op
// is still live, the peer guard in op-submit-async.ts catches the same thing
// with no time limit.) 30s comfortably covers one chat turn end-to-end.
export interface RecentSubmit { opId: string; ts: number; task: string }
export const RECENT_SUBMITS = new Map<string, RecentSubmit[]>();
export const SUBMIT_DEDUP_WINDOW_MS = 30_000;

/**
 * Near-duplicate test between two task strings — same normalization the
 * completion-history dedup uses (pending-notifications.findRecentCompletionMatching):
 * lowercase, collapse whitespace, cap length, and treat either string being a
 * substring of the other as a match. Distinct tasks fall through.
 */
export function tasksNearDuplicate(a: string, b: string): boolean {
  const norm = (s: string) => s.toLowerCase().replace(/\s+/g, " ").trim().slice(0, 120);
  const x = norm(a);
  const y = norm(b);
  if (x.length < 8 || y.length < 8) return false;
  return x.includes(y) || y.includes(x);
}

/** The session's in-window submission that `task` re-asserts, if any.
 *  Expired entries are dropped here, so the map is bounded by the window. */
export function recentDuplicateSubmit(sessionId: string, task: string): RecentSubmit | undefined {
  const now = Date.now();
  const live = (RECENT_SUBMITS.get(sessionId) ?? []).filter((e) => now - e.ts < SUBMIT_DEDUP_WINDOW_MS);
  if (live.length === 0) RECENT_SUBMITS.delete(sessionId);
  else RECENT_SUBMITS.set(sessionId, live);
  return live.find((e) => tasksNearDuplicate(e.task, task));
}

export function recordRecentSubmit(sessionId: string, opId: string, task: string): void {
  const entries = RECENT_SUBMITS.get(sessionId) ?? [];
  entries.push({ opId, ts: Date.now(), task });
  RECENT_SUBMITS.set(sessionId, entries);
}

// Polling-loop guard for op_status / op_wait. The chat agent kept calling
// op_status on the same op_id 16 times in one turn waiting for a long-running
// op to finish. Track per-session calls per op_id within a short window; after
// the second call return a STOP-polling message that ends the turn.
export const RECENT_POLLS = new Map<string, { opId: string; tool: string; count: number; firstAt: number; lastAt: number }>();
export const POLL_LOOP_WINDOW_MS = 60_000;
export const POLL_LOOP_MAX = 1; // first call returns rich data; second call returns STOP
