/**
 * Op tools — let the chat agent delegate work to the canonical-loop.
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
 *                     scheduler summary.
 *   op_kill         — Cancel an op (cooperative; transitions running →
 *                     cancelling, aborts the adapter mid-stream).
 *   op_redirect     — Inject an instruction into a running op (latest-wins).
 *
 * Why async-first: a blocking op_submit holds the chat agent's turn open
 * until the op finishes. The async variant is the actual UX unblock that
 * makes the delegation feel like a parallel system instead of a sync RPC.
 */

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ToolDefinition } from "../types.js";
import {
  opCancel,
  opRedirect,
  canonicalLoopEntry,
  registerAdapterForOp,
  schedulerSnapshot,
  awaitCanonicalOp,
} from "../canonical-loop/index.js";
import { readOp, listOps, newOpId } from "./op-store.js";
import { readEvents } from "./event-log.js";
import { readCheckpoint } from "./checkpoint.js";
import { buildContextPack } from "./context-pack-builder.js";
import { getRetryPolicy } from "./heartbeat.js";
import { trackOpForSession, listOpsForSession } from "./session-bridge.js";

/**
 * Read the user's currently-selected provider from ~/.lax/settings.json.
 * Used to pick the canonical adapter for ops that don't carry an explicit
 * provider hint. Same source as the chat resolver, so adapter selection
 * stays consistent with what the rest of the app shows.
 */
async function readSettingsProvider(): Promise<string | null> {
  try {
    const sp = join(homedir(), ".lax", "settings.json");
    if (!existsSync(sp)) return null;
    const s = JSON.parse(readFileSync(sp, "utf-8"));
    return typeof s.provider === "string" ? s.provider : null;
  } catch {
    return null;
  }
}
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
    task: { type: "string", description: "Plain-English description of what the worker should do. CRITICAL: the worker does NOT see the chat thread — only this `task` string + `context_files` / `scope_hint` / `memory_query`. If the user referred to anything earlier in the conversation (a specific service, handle, business name, file path, prior decision, etc.), you MUST repeat it here verbatim or the worker will guess wrong. Example: user said 'Instagram for sipdirty805' three turns ago, then 'connect my nutrishop account' now — the task must include 'Instagram, sipdirty805', not just 'connect my account'." },
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

// ── op_submit_async — primary verb (non-blocking) ─────────────────────────

// Per-session dedup window. Anthropic's MCP-bridge tool loop (and to a lesser
// extent every model under tool-use pressure) sometimes re-asserts a delegation
// 3-5 times in one turn — usually with slightly different task phrasing each
// time, so a per-task-string dedup misses them. We dedup at the SESSION level:
// one op_submit_async per session per window, period. If the supervisor needs
// truly-parallel ops, it can submit again after the window or after the prior
// op completes. 30s comfortably covers one chat turn end-to-end.
const RECENT_SUBMITS = new Map<string, { opId: string; ts: number; task: string }>();
const SUBMIT_DEDUP_WINDOW_MS = 30_000;

// Polling-loop guard for op_status / op_wait. The chat agent kept calling
// op_status on the same op_id 16 times in one turn waiting for a long-running
// op to finish. Track per-session calls per op_id within a short window; after
// the second call return a STOP-polling message that ends the turn.
const RECENT_POLLS = new Map<string, { opId: string; tool: string; count: number; firstAt: number; lastAt: number }>();
const POLL_LOOP_WINDOW_MS = 60_000;
const POLL_LOOP_MAX = 1; // first call returns rich data; second call returns STOP

export const opSubmitAsyncTool: ToolDefinition = {
  name: "op_submit_async",
  description:
    "PREFERRED for any task >5 seconds. Delegates to a worker process and returns the opId IMMEDIATELY — your chat turn does not block. Submit ONCE per logical task; if you call this tool a second time with the same task in the same turn, you'll get the existing opId back (no second worker spawned). Tell the user 'started, I'll let you know when it's done' and move on. The user is automatically notified when the op completes via a chat update; you can also call op_status(opId) on any future turn. Use op_wait(opId) only if you genuinely need the result before answering the current turn. ALWAYS pass `lane` explicitly: use `lane:'interactive'` for pure reasoning / Q&A / summarization / research synthesis / status checks / planning / reviewing / explaining / non-mutating analysis (worker does NOT touch files or run builds), `lane:'build'` for code edits / app builds / file writes / refactors / shell or test work / OAuth + account / integration setup, `lane:'background'` for scheduled or low-priority recurring jobs. Picking the right lane matters — interactive ops finish in seconds; build ops can take minutes. CONTEXT-RELAY RULE: workers do NOT see the chat thread. If a delegated task depends on prior context (a service name, handle, business, file, prior decision), include it explicitly in `task` / `scope_hint` / `context_files` / `memory_query` — otherwise the worker guesses and is usually wrong. OAUTH / ACCOUNT-CONNECTION / INTEGRATION-SETUP tasks must include in the task string: (1) target service or platform (e.g. Instagram, Gmail, Stripe), (2) account / business / handle if known, (3) intended outcome (e.g. 'read DMs', 'post on behalf of'), (4) whether user-side auth is expected. AMBIGUITY GUARD: if any of those four is unclear from the conversation (e.g. user said 'connect my account' with no service named, or you have multiple plausible accounts), ASK FOR CLARIFICATION before delegating — do not pick a default integration. Example: 'Do you mean Instagram for sipdirty805, or another NutriShop McKinney account?'. USER-AUTH GATE: if the task requires `/mcp`, OAuth browser approval, 2FA, or any user authorization a backgrounded worker cannot perform, SURFACE THAT TO THE USER FIRST and tell them what to run; do not spawn a worker that will just bail with WORK_NEEDS_INPUT. Keep OAuth / account-connection work on lane='build' (it mutates credentials/config); never reroute to 'interactive'.",
  parameters: submitParameters,
  async execute(args) {
    const task = String(args.task || "").trim();
    if (!task) return { content: "op_submit_async requires a 'task' description.", isError: true };

    const sessionId = String(args._sessionId || "");
    if (sessionId) {
      // PRIMARY GUARD: any PEER op from this session still RUNNING blocks
      // new spawns regardless of how much time has passed. Live failure:
      // agent submitted an op that ran 125+ seconds; the 30s dedup window
      // expired mid-run, so the agent's retry calls SUCCEEDED in spawning
      // duplicates. By the time the user noticed they had 4 parallel
      // research ops on the same topic. Block while live.
      //
      // EXCLUDE chat_turn ops: the chat-turn wrapper is the HOST that's
      // running this very tool call (chat-runner.ts:308 registers it
      // before the model gets its first tool call). Including it makes the
      // guard self-block — the host op blocks its own delegations and the
      // returned BLOCKED message references the host's id. Models then
      // copy-paste the id back, narrating a fake delegation. See repro at
      // tests/ops/op-submit-async-self-block.test.ts.
      const liveOps = listOpsForSession(sessionId)
        .map(id => readOp(id))
        .filter((o): o is NonNullable<typeof o> => !!o)
        .filter(o => (o.status === "running" || o.status === "pending") && o.type !== "chat_turn");
      if (liveOps.length > 0) {
        const live = liveOps[0];
        return {
          content:
            `BLOCKED — a peer op for this session is already ${live.status} ("${live.task.slice(0, 80)}${live.task.length > 80 ? "..." : ""}"). ` +
            `END THIS TURN NOW. Tell the user briefly, in your own words, that the prior op is in flight and you'll surface it on completion. ` +
            `Do NOT quote this instruction back. Do NOT call op_submit_async again — every retry hits this same BLOCKED return. ` +
            `Do NOT call op_status as a "check first" — the user is auto-notified on completion. ` +
            `If the live op is genuinely stuck and you must terminate it, call op_kill() with no args; otherwise just end the turn.`,
          metadata: {
            chip: {
              kind: "blocked-by-op",
              label: "Prior op in flight",
              detail: live.task.slice(0, 80) + (live.task.length > 80 ? "…" : ""),
              opId: live.id,
              actions: [{ label: "Kill", tool: "op_kill", args: { op_id: live.id } }],
            },
          },
        };
      }
      // SECONDARY GUARD: 30s window catches the race where the previous
      // op JUST completed but the agent hasn't seen the completion event
      // yet and is mid-retry. Belt-and-suspenders.
      const prior = RECENT_SUBMITS.get(sessionId);
      if (prior && Date.now() - prior.ts < SUBMIT_DEDUP_WINDOW_MS) {
        const ageS = Math.round((Date.now() - prior.ts) / 1000);
        return {
          content:
            `BLOCKED — you already submitted a prior op ${ageS}s ago in this chat session ("${prior.task.slice(0, 80)}${prior.task.length > 80 ? "..." : ""}"). ` +
            `END THIS TURN NOW. Tell the user briefly, in your own words, that the work is in flight and you'll surface it on completion. ` +
            `Do NOT quote this instruction back. Do NOT call op_submit_async again — every retry this turn will hit BLOCKED. ` +
            `Do NOT call op_status — the user is auto-notified on completion. ` +
            `If you legitimately need to delegate something *different* later, that's a future turn, not this one.`,
          metadata: {
            chip: {
              kind: "blocked-by-op",
              label: `Just submitted (${ageS}s ago)`,
              detail: prior.task.slice(0, 80) + (prior.task.length > 80 ? "…" : ""),
              opId: prior.opId,
            },
          },
        };
      }
      // Casual-reply guard: if the user's last message was short/casual
      // ("yo", "hey", "ok", "thanks") AND any recent completion exists in
      // this session, block ALL op spawns — the user is acknowledging, not
      // requesting new work. Catches paraphrased re-delegations that the
      // task-similarity check misses (different phrasing, same intent).
      const { findRecentCompletionMatching, findAnyRecentCompletion } = await import("./pending-notifications.js");
      const { isLastMessageCasual } = await import("./idle-nudge.js");
      if (isLastMessageCasual(sessionId)) {
        const anyRecent = findAnyRecentCompletion(sessionId);
        if (anyRecent) {
          const ageMin = Math.round((Date.now() - anyRecent.completedAt) / 60000);
          return {
            content:
              `BLOCKED — your last user message was a short/casual reply (greeting, ack, or filler). ` +
              `A prior op completed ${ageMin} min ago in this session — the user is most likely acknowledging that, not requesting new work. ` +
              `END THIS TURN NOW. Reply conversationally — acknowledge in your own words, and surface the prior result if it's relevant. ` +
              `Do NOT quote op ids back to the user. Do NOT call op_submit_async again — retries will keep hitting BLOCKED.`,
          };
        }
      }

      // Task-similarity guard: catches re-delegations where the user message
      // was substantive but the requested task overlaps with one already
      // completed (e.g., "redo the count" hitting the same target).
      const completed = findRecentCompletionMatching(sessionId, task);
      if (completed) {
        const ageMin = Math.round((Date.now() - completed.completedAt) / 60000);
        return {
          content:
            `BLOCKED — a near-identical task already completed in this chat ${ageMin} min ago (status=${completed.status}). ` +
            `Do NOT re-spawn workers for already-completed work. The result is sitting in the BACKGROUND COMPLETIONS section of your context — read it from there. ` +
            `Surface it to the user in your own words and offer the next step.`,
          metadata: {
            chip: {
              kind: "blocked-by-op",
              label: `Already done (${ageMin}m ago)`,
              detail: `status: ${completed.status}`,
              opId: completed.opId,
            },
          },
        };
      }
    }

    const op = await buildOpFromArgs(args);

    if (sessionId) {
      trackOpForSession(op.id, sessionId, task);
      RECENT_SUBMITS.set(sessionId, { opId: op.id, ts: Date.now(), task });
    }

    // Per-op adapter selection by the op's effective provider. Provider
    // follows the op's explicit hint, falling back to settings.json. User
    // picks codex in settings → ops register CodexAdapter; otherwise the
    // lane-default AnthropicAdapter from canonical-loop-bootstrap.ts
    // serves the op.
    const opProvider = op.contextPack?.routing?.preferredProvider;
    const effectiveProvider = opProvider ?? (await readSettingsProvider());
    if (effectiveProvider === "codex") {
      const { createCodexAdapter } = await import("../canonical-loop/index.js");
      registerAdapterForOp(op.id, () => createCodexAdapter({ sessionId: sessionId || undefined }));
    }
    canonicalLoopEntry(op, sessionId ? { sessionId } : {});

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
    "BLOCKS your chat turn — the user CANNOT reply while this is running, and the chat UI shows a stop button. Default to NOT calling this. After op_submit_async, just tell the user 'started, I'll let you know when it's done' and return; the session bridge auto-surfaces the completion in a future turn. ONLY call op_wait if your CURRENT response cannot be composed without the op's result (e.g., the user asked 'what's the answer?' and you must read it out of the op output to reply). Phrases like 'tell me what status' or 'let me know when done' do NOT require op_wait — auto-notify handles those.",
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
    const result = await awaitCanonicalOp(opId, timeoutMs);
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
    "Convenience: submit an op AND wait for the result, in one call. Equivalent to op_submit_async + op_wait. ONLY use this for short ops (<10s) where blocking the user is acceptable. For anything heavier — builds, refactors, multi-file research — call op_submit_async instead so you can respond to the user immediately and surface the result via the auto-notification when it's ready. ALWAYS pass `lane` explicitly: `lane:'interactive'` for pure reasoning / Q&A / summarization / research synthesis / status checks / planning / reviewing / explaining / non-mutating analysis, `lane:'build'` for code edits / app builds / file writes / refactors / shell or test work / OAuth + account / integration setup, `lane:'background'` for scheduled or low-priority recurring jobs. CONTEXT-RELAY RULE: workers do NOT see the chat thread; copy any prior conversation context the worker needs into `task` / `scope_hint` / `context_files`. OAUTH / ACCOUNT-CONNECTION tasks: the task string must include (1) target service, (2) account/handle/business, (3) intended outcome, (4) whether user-side auth is expected. If any of those is unclear, ASK before delegating. If the task requires `/mcp`, OAuth approval, or 2FA, surface that to the user first instead of spawning a worker that will bail with WORK_NEEDS_INPUT. Keep OAuth/account-connection work on lane='build'.",
  parameters: submitParameters,
  async execute(args) {
    const task = String(args.task || "").trim();
    if (!task) return { content: "op_submit requires a 'task' description.", isError: true };

    const sessionId = String(args._sessionId || "");
    const op = await buildOpFromArgs(args);
    if (sessionId) trackOpForSession(op.id, sessionId, task);

    const opProvider = op.contextPack?.routing?.preferredProvider;
    const effectiveProvider = opProvider ?? (await readSettingsProvider());
    if (effectiveProvider === "codex") {
      const { createCodexAdapter } = await import("../canonical-loop/index.js");
      registerAdapterForOp(op.id, () => createCodexAdapter({ sessionId: sessionId || undefined }));
    }
    const startMs = Date.now();
    canonicalLoopEntry(op, sessionId ? { sessionId } : {});
    const result = await awaitCanonicalOp(op.id, 30 * 60 * 1000);
    const wallMs = Date.now() - startMs;

    if (!result) {
      return {
        content: `op ${op.id} did not complete within 30 min. Call op_status(op_id="${op.id}") to check.`,
        isError: true,
      };
    }

    const summary =
      `op ${op.id} ${result.status} in ${Math.round(wallMs / 1000)}s` +
      (result.error ? `\n  error: ${result.error.message}` : "") +
      (result.filesChanged.length > 0 ? `\n  files: ${result.filesChanged.slice(0, 5).join(", ")}${result.filesChanged.length > 5 ? "..." : ""}` : "") +
      `\n\n${result.finalSummary}`;

    return { content: summary, isError: result.status !== "completed" };
  },
};

// ── op_status, op_kill, op_redirect ────────────────────────────────────────

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
      const snap = schedulerSnapshot();
      const { listActiveCanonicalOps } = await import("../canonical-loop/index.js");
      const canonicalActive = listActiveCanonicalOps();
      const sessionOpIds = sessionId ? listOpsForSession(sessionId) : [];
      const sessionOpEntries = sessionOpIds
        .map(id => readOp(id))
        .filter((o): o is NonNullable<typeof o> => !!o);
      const recent = sessionOpEntries.length > 0
        ? sessionOpEntries.slice(-10).map(o => `  - ${o.id} [${o.status}] ${o.task.slice(0, 80)}`).join("\n")
        : (listOps().slice(0, 10).map(o => `  - ${o.id} [${o.status}] ${o.task.slice(0, 80)}`).join("\n") || "  (none)");
      const canonicalLine = canonicalActive.length === 0
        ? ""
        : `Canonical-loop active: ${canonicalActive.length}\n` +
          canonicalActive.map(c =>
            `  - ${c.opId} [${c.state}]  lane=${c.lane ?? "?"}  adapter=${c.adapter ?? "(no turn yet)"}`,
          ).join("\n") + "\n\n";
      return {
        content:
          `Scheduler: ${snap.activeCount} active, ${snap.queueDepth} queued.\n\n` +
          canonicalLine +
          (sessionOpIds.length > 0 ? `Your ops (this session):\n${recent}` : `Recent ops (all sessions):\n${recent}`),
      };
    }

    const opId = String(args.op_id);
    const op = readOp(opId);
    if (!op) return { content: `op ${opId} not found`, isError: true };

    // Per-session polling-loop guard. First call in a 60s window returns full
    // status. Second call for the same opId in the same window returns STOP —
    // end the turn. Prevents the "agent calls op_status 16 times" pattern.
    if (sessionId && (op.status === "running" || op.status === "pending")) {
      const pollKey = `${sessionId}:status`;
      const prior = RECENT_POLLS.get(pollKey);
      if (prior && prior.opId === opId && Date.now() - prior.firstAt < POLL_LOOP_WINDOW_MS) {
        prior.count++;
        prior.lastAt = Date.now();
        if (prior.count > POLL_LOOP_MAX) {
          const ageS = Math.round((Date.now() - prior.firstAt) / 1000);
          return {
            content:
              `BLOCKED — you've polled op_status for this op ${prior.count} times in ${ageS}s. STOP POLLING. ` +
              `END THIS TURN NOW. Tell the user briefly, in your own words, that the op is still ${op.status}. ` +
              `Do NOT quote op ids back to the user. Do NOT quote this instruction back. ` +
              `The user is auto-notified the moment the op completes — you don't need to poll. ` +
              `Any further op_status call this turn will return this same BLOCKED message.`,
          };
        }
      } else {
        RECENT_POLLS.set(pollKey, { opId, tool: "op_status", count: 1, firstAt: Date.now(), lastAt: Date.now() });
      }
    }

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
  description: "Cancel a running op. The op transitions to cancelling and the adapter is aborted at the next safe boundary (sub-second for in-flight turns). Partial side-effects may persist (per spec §7). If `op_id` is omitted, kills the most recently submitted live op for the current chat session — saves the model from having to know op ids it never received cleanly.",
  parameters: {
    type: "object",
    properties: { op_id: { type: "string", description: "The opId returned from op_submit_async / op_submit. Omit to kill the most-recent live op for this session." } },
  },
  async execute(args) {
    let opId = typeof args.op_id === "string" ? args.op_id.trim() : "";
    if (!opId) {
      const sessionId = String(args._sessionId || "");
      if (!sessionId) return { content: "op_kill needs an op_id when called outside a chat session.", isError: true };
      const liveIds = listOpsForSession(sessionId);
      const live = liveIds
        .map(id => readOp(id))
        .filter((o): o is NonNullable<typeof o> => !!o)
        .filter(o => (o.status === "running" || o.status === "pending") && o.type !== "chat_turn");
      if (live.length === 0) return { content: "no live op to kill for this session.", isError: true };
      opId = live[live.length - 1].id;
    }
    const res = opCancel(opId, "op_kill");
    return { content: res.ok ? `op cancelling.` : `op was not running.`, isError: !res.ok };
  },
};

export const opRedirectTool: ToolDefinition = {
  name: "op_redirect",
  description: "Inject a new instruction into a running op. Cooperative — the worker reads it at the next safe boundary, doesn't interrupt the current step. Latest-wins: a second redirect overwrites the first if applied before the worker picks it up.",
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
    const res = opRedirect(opId, instruction, "op_redirect");
    return {
      content: res.ok
        ? `Instruction injected into ${opId}. Worker will pick it up at next safe boundary.`
        : `op ${opId} not running`,
      isError: !res.ok,
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
