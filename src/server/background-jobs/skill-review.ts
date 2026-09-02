/**
 * Skill review — the post-turn procedural-learning fork.
 *
 * After a turn does non-trivial tool work, the conversation is replayed to a
 * background fork that asks itself one question: did a reusable procedure
 * emerge here, and should a protocol be written or patched? It then does it,
 * autonomously, with no user confirmation. Protocols it writes are stamped with
 * agent provenance so the user can tell them from their own and archive them —
 * that stamp, plus one-action archive, replaces the consent gate.
 *
 * Why this exists: the same workflow was run 3+ times and captured 3+ times —
 * every time into the DECLARATIVE store (158 facts, several of them the
 * procedure written out longhand as observations) and never once into the
 * PROCEDURAL one. It came back as loose prose ranked by similarity instead of
 * an ordered playbook. This job closes that gap.
 *
 * Shape follows dream-check.ts: runAgentViaCanonical on lane "background", a
 * hand-filtered tool list, its own static prompt, a synthetic sessionId. No
 * FieldAgent, no WS broadcast, no AgentRunStore row — a review must be
 * invisible to the AGENTS panel. Deliberately NOT agents/invoke.ts, which
 * broadcasts spawn/token/complete events to every client unconditionally and
 * silently discards a tool override when a templateId resolves.
 *
 * This file owns the queue and the run. The prompt and tool surface live in
 * skill-review-prompt.ts; the failure breaker in skill-review-breaker.ts.
 */
import { type AgentOptions } from "../../providers/types.js";
import { runAgentViaCanonical } from "../../canonical-loop/index.js";
import { renderPromptSection } from "../../context/system-prompt-builder.js";
import { SecurityLayer } from "../../security/index.js";
import type { AgentTurn, LAXConfig, ToolDefinition } from "../../types.js";
import type { SecretsStore } from "../../secrets.js";
import type { ToolPolicy } from "../../tool-policy/index.js";
import { createLogger } from "../../logger.js";
import { createOverlapGuard } from "../scheduler.js";
import { SkillReviewBreaker, type SkillReviewBreakerState } from "./skill-review-breaker.js";
import {
  SKILL_REVIEW_SYSTEM_PROMPT,
  SKILL_REVIEW_TOOL_NAMES,
  buildSkillReviewMessage,
  narrowProtocolToolForReview,
} from "./skill-review-prompt.js";

const logger = createLogger("server.background-jobs.skill-review");

/** Synthetic session ids the fork runs under. Also the self-review guard: a
 *  request naming a session with this prefix is refused, so a review can never
 *  queue a review of itself. */
export const SKILL_REVIEW_SESSION_PREFIX = "skill-review-";

/**
 * Triviality gate (campaign D4: trigger on tool-iteration count, not on the
 * memory pass's curate signal — that measures memory-worthiness, a different
 * axis). Distinct-tool count is the cheap precision half: six `read` calls in a
 * row is a search, not a procedure.
 */
export const MIN_TOOL_CALLS_FOR_REVIEW = 4;
export const MIN_DISTINCT_TOOLS_FOR_REVIEW = 2;

/** Scheduler poll cadence — one value for the ./index.ts registration and
 *  the breaker's backoff base, so the two cannot drift. */
export const SKILL_REVIEW_POLL_INTERVAL_MS = 5 * 60 * 1000; // 5min

/** Reviews drained per scheduler tick. Bounds the cost of a burst. */
const MAX_REVIEWS_PER_PASS = 3;
/** Ceiling on queued reviews. Oldest is dropped past this. */
const MAX_PENDING = 20;

/**
 * Wall-clock ceiling per review, enforced HERE because canonical's is not
 * enforced for us.
 *
 * `options.wallClockMs` lands on the op's budget, but worker.ts arms the
 * deadline timer only for `op.lane === "interactive"`, so on the background
 * lane `deadlineExceeded` can never be set. `maxIterations` is no better: the
 * worker's `continuing = op.lane !== "interactive"` makes a background op emit
 * an `iteration_checkpoint`, reset its counter, and keep going — the value is a
 * logging cadence, not a cap. And a middleware `suspend` parks the op in
 * `paused`, which is not a terminal state, so `runAgentViaCanonical`'s
 * `while (terminal === null)` would never resolve and this pass would hang for
 * the life of the process.
 *
 * One timeout closes all three: it aborts the signal (which canonical routes to
 * opCancel, so the op actually stops rather than being merely abandoned) and it
 * resolves the pass either way. Without it a review runs the MAIN model with no
 * turn ceiling and no clock — which is not the trade P1 made.
 *
 * The lane-scoped wall clock in worker.ts is a repo-wide defect owned
 * elsewhere; this is the fix that fits inside this job's footprint.
 */
export const DEFAULT_REVIEW_TIMEOUT_MS = 5 * 60 * 1000;

export interface SkillReviewRequest {
  /** Session whose turn is under review. Becomes the protocol's
   *  `authoredFromSession` provenance. */
  sessionId: string;
  /** Ordered tool names for the whole op (collectToolSequence output). */
  toolSequence: readonly string[];
  /** The conversation to review, already rendered to plain text. */
  transcript: string;
}

export type SkillReviewQueueResult =
  | { queued: true }
  | { queued: false; reason: "trivial" | "no-transcript" | "self-review" | "no-session" };

/**
 * Own coalescer state, keyed by session (campaign D3). The memory end-of-turn
 * pass keeps its own; a single shared pending slot would let whichever fired
 * last starve the other.
 */
const pending = new Map<string, SkillReviewRequest>();

/** True when the turn did enough tool work to plausibly contain a procedure.
 *  Total-tolerant: chunk E calls this from the turn loop, where a throw would
 *  break the user's turn, so a malformed sequence is "not worthy", not a crash. */
export function isReviewWorthy(toolSequence: readonly string[] | undefined): boolean {
  if (!Array.isArray(toolSequence)) return false;
  if (toolSequence.length < MIN_TOOL_CALLS_FOR_REVIEW) return false;
  return new Set(toolSequence).size >= MIN_DISTINCT_TOOLS_FOR_REVIEW;
}

/**
 * Entry point for the turn-loop trigger (chunk E). Cheap and synchronous: it
 * gates and enqueues, it never runs a model. The scheduler drains the queue
 * once the foreground has gone idle, so a turn never pays for its own review.
 */
export function requestSkillReview(request: SkillReviewRequest): SkillReviewQueueResult {
  const sessionId = typeof request?.sessionId === "string" ? request.sessionId.trim() : "";
  if (!sessionId) return { queued: false, reason: "no-session" };
  if (sessionId.startsWith(SKILL_REVIEW_SESSION_PREFIX)) return { queued: false, reason: "self-review" };
  if (typeof request.transcript !== "string" || !request.transcript.trim()) return { queued: false, reason: "no-transcript" };
  if (!isReviewWorthy(request.toolSequence)) return { queued: false, reason: "trivial" };

  // Latest turn wins for a given session — reviewing the newest state of a
  // conversation subsumes reviewing an earlier slice of it.
  pending.delete(sessionId);
  pending.set(sessionId, { ...request, sessionId, toolSequence: [...request.toolSequence] });
  while (pending.size > MAX_PENDING) {
    const oldest = pending.keys().next();
    if (oldest.done) break;
    pending.delete(oldest.value);
  }
  return { queued: true };
}

export interface SkillReviewDeps {
  config: LAXConfig;
  dataDir: string;
  secretsStore: SecretsStore;
  security: SecurityLayer;
  toolPolicy: ToolPolicy;
  allAgentTools: ToolDefinition[];
  /** Per-review wall-clock ceiling. Defaults to DEFAULT_REVIEW_TIMEOUT_MS. */
  timeoutMs?: number;
}

let deps: SkillReviewDeps | null = null;
/** Re-entrancy guard for this exported entry point — "3 reviews per tick" is a
 *  batch size, not a concurrency bound. The latch itself is JobScheduler's
 *  (src/server/scheduler.ts), the same primitive it applies to every job
 *  registered on the default "skip" overlap policy, skill-review among them;
 *  this file no longer keeps a flag of its own. Pinned by
 *  src/server/scheduler.test.ts ("consults the guard createOverlapGuard
 *  minted, not a private flag") so a private boolean can't creep back. */
const passGuard = createOverlapGuard();

/** Spend breaker (Aug 31: hours of all-failure passes at full main-model
 *  spend, one every 5 minutes, zero value). In-memory on purpose — a restart
 *  resetting it IS the recovery path. See ./skill-review-breaker.ts. */
const breaker = new SkillReviewBreaker(SKILL_REVIEW_POLL_INTERVAL_MS, logger);

/** Current breaker state. The job's status surface is its logs plus this — no
 *  jobs status endpoint exists (BackgroundJobsHandle exposes only the scheduler). */
export const getSkillReviewBreakerState = (): SkillReviewBreakerState => breaker.state();

/** Capture the heavy server deps so the scheduler can drive a pass without
 *  holding them. Mirrors registerDreamRunnerForServer. */
export function registerSkillReviewRunner(next: SkillReviewDeps): void {
  deps = next;
  logger.info("[skill-review] Runner registered");
}

export interface SkillReviewPassResult {
  reviewed: number;
  failed: number;
  skipped: boolean;
  reason?: "no-runner" | "empty" | "in-flight" | "breaker-backoff" | "parked";
}

/**
 * Drain the queue. Registered on the shared foreground-idle gate, and the
 * background lane is 1-concurrent, so reviews queue behind each other and
 * behind every other LLM-heavy background job rather than competing with a
 * live turn.
 */
export async function runSkillReviewPass(options: { force?: boolean } = {}): Promise<SkillReviewPassResult> {
  if (!deps) return { reviewed: 0, failed: 0, skipped: true, reason: "no-runner" };
  // Breaker gate — SCHEDULED spend only. `force` is the manual seam (no src/
  // caller passes it today; the ./index.ts registration is the only production
  // call site): it must never refuse a human, and a forced success un-parks.
  if (!options.force) {
    const blocked = breaker.blocks();
    if (blocked) return { reviewed: 0, failed: 0, skipped: true, reason: blocked };
  }
  if (!passGuard.tryEnter()) return { reviewed: 0, failed: 0, skipped: true, reason: "in-flight" };

  let reviewed = 0;
  let failed = 0;
  try {
    if (pending.size === 0) return { reviewed: 0, failed: 0, skipped: false, reason: "empty" };

    const batch: SkillReviewRequest[] = [];
    for (const [key, request] of pending) {
      if (batch.length >= MAX_REVIEWS_PER_PASS) break;
      pending.delete(key);
      batch.push(request);
    }

    for (const request of batch) {
      try {
        await runSingleReview(request, deps);
        reviewed++;
      } catch (e) {
        // Never swallow: a review that dies silently is a learning loop that
        // looks healthy and does nothing. The request is intentionally NOT
        // requeued — a persistently failing transcript would retry forever.
        failed++;
        logger.warn(`[skill-review] Review of session ${request.sessionId} failed: ${(e as Error).message}`);
      }
    }

    // Breaker verdict: any completed review means the spend bought something
    // (full reset, park included); an all-failure batch deepens the streak; an
    // empty pass says nothing either way. Failure logging above is untouched.
    if (reviewed > 0) breaker.recordSuccess();
    else if (failed > 0) breaker.recordFailure();
  } finally {
    passGuard.release();
  }
  return { reviewed, failed, skipped: false };
}

let reviewSeq = 0;

async function runSingleReview(request: SkillReviewRequest, d: SkillReviewDeps): Promise<void> {
  const { resolveProvider } = await import("../../agent-request/index.js");
  const { provider, apiKey, model } = await resolveProvider(d.config, d.secretsStore, d.dataDir);

  // MAIN model, not backgroundModelFor(). A deliberate divergence from
  // dream-check, which uses the cheap per-provider background model: writing a
  // playbook someone will follow is a judgement task, and a bad protocol is
  // worse than none. Cost is bounded instead by the idle gate, the per-pass
  // batch cap, and a static prompt + static tool list that shares the
  // provider's 5-minute prefix cache across forks.
  const forkSessionId = `${SKILL_REVIEW_SESSION_PREFIX}${Date.now()}-${reviewSeq++}`;
  const tools = buildReviewTools(d.allAgentTools, request.sessionId);
  if (tools.length === 0) {
    throw new Error(`no review tools resolved (expected ${SKILL_REVIEW_TOOL_NAMES.join(", ")})`);
  }

  // The only real ceiling this job has — see DEFAULT_REVIEW_TIMEOUT_MS. Abort
  // fires opCancel through canonical so the op genuinely stops; the race
  // guarantees this pass resolves even if the op parks in a non-terminal state.
  const timeoutMs = d.timeoutMs ?? DEFAULT_REVIEW_TIMEOUT_MS;
  const abort = new AbortController();
  let timedOut = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expiry = new Promise<"timeout">((resolve) => {
    timer = setTimeout(() => { timedOut = true; abort.abort(); resolve("timeout"); }, timeoutMs);
  });

  logger.info(`[skill-review] Reviewing session ${request.sessionId} (${request.toolSequence.length} tool calls)`);
  const run = runAgentViaCanonical(
    buildSkillReviewMessage({
      sessionId: request.sessionId,
      toolSequence: request.toolSequence,
      transcript: request.transcript,
    }),
    [],
    {
      apiKey,
      model,
      provider: provider as AgentOptions["provider"],
      systemPrompt: SKILL_REVIEW_SYSTEM_PROMPT,
      renderedPromptSections: [renderPromptSection({
        id: "skill-review",
        label: "Protocol Review",
        type: "static",
        policy: "required",
        text: SKILL_REVIEW_SYSTEM_PROMPT,
      })],
      tools,
      security: d.security,
      toolPolicy: d.toolPolicy,
      sessionId: forkSessionId,
      signal: abort.signal,
      // Both of these are honoured only on the interactive lane; kept because
      // maxIterations still drives checkpoint cadence and wallClockMs is the
      // right declared budget if the worker's lane gate is ever fixed. Neither
      // is load-bearing — the timeout above is.
      maxIterations: 12,
      wallClockMs: timeoutMs,
      temperature: 0.3,
      callContext: "delegated",
      opType: "skill_review",
      lane: "background",
      // The transcript is machine-composed, not user-typed — the
      // instruction-ledger middleware must not mine constraints out of it.
      harnessAuthoredTask: true,
    },
  );

  let outcome: Awaited<typeof run> | "timeout";
  try {
    outcome = await Promise.race([run, expiry]);
  } finally {
    if (timer) clearTimeout(timer);
  }

  if (timedOut || outcome === "timeout") {
    // Don't let the abandoned run reject unhandled once it unwinds.
    void run.catch(() => { /* already accounted for as a timeout */ });
    throw new Error(`review exceeded ${timeoutMs}ms and was cancelled`);
  }

  const wrote = outcome.messages.filter(
    (m) => m.role === "assistant" && Array.isArray((m as { tool_calls?: unknown[] }).tool_calls),
  ).length;
  const failure = reviewFailure(outcome);
  if (failure) {
    throw new Error(`fork ${forkSessionId} ${failure} after ${wrote} tool-calling turns`);
  }
  logger.info(`[skill-review] Session ${request.sessionId} reviewed (${wrote} tool-calling turns)`);
}

/** Longest slice of the op's error message the failure line carries. Middleware
 *  abort messages are model-facing nudge paragraphs; mirrors event-pump's cap. */
const FAILURE_MESSAGE_MAX = 240;

/**
 * Why a resolved run is still a failed review, or null when it succeeded.
 *
 * `runAgentViaCanonical` resolves on ANY terminal state — `failed` (a
 * middleware abort such as repeat-output / loop-detection / thrash-guard, an
 * exhausted adapter, a worker exception) and `cancelled` included — and folds
 * the terminal into `stopReason` (agent-runner/collect-result.ts mapStopReason:
 * succeeded→end_turn, cancelled→abort, failed→error; the fold is injective, so
 * the terminal is recovered here without touching the runner). The fold also
 * maps a `failed` carrying error code `max_turns_exceeded` to `max_iterations`,
 * but nothing in src/ emits that code today — the branch below is defensive
 * (a failed terminal by construction), not a path a review can currently hit.
 * When the loop emitted an `error` event the runner also returns it as
 * `errorMessage` = `<code>: <message>` — for a middleware abort that is
 * `middleware-abort: <the middleware's message>`, the closest the seam gets to
 * the abort reason. The op id itself is not returned; the fork session id is
 * unique per review and is what the runner logs the op id against.
 *
 * Before this check a run that resolved at all counted as reviewed, so a night
 * of middleware-aborted ops (every one `failed`, idle-nudge saying "hit a
 * snag") logged `pass: reviewed=1 failed=0`.
 */
function reviewFailure(outcome: AgentTurn): string | null {
  if (outcome.stopReason === "abort") return "ended cancelled (stopReason=abort)";
  if (outcome.stopReason === "error" || outcome.stopReason === "max_iterations") {
    const detail = outcome.errorMessage ? `: ${outcome.errorMessage.slice(0, FAILURE_MESSAGE_MAX)}` : "";
    return `ended failed (stopReason=${outcome.stopReason}${detail})`;
  }
  return null;
}

/**
 * Resolve the fork's tools from the live registry (so policy wrapping and
 * lineage instrumentation are preserved) and narrow `protocol` to the review
 * surface. Exported for the allowlist test — the recursion guard is a property
 * of this list and nothing else.
 */
export function buildReviewTools(
  allAgentTools: readonly ToolDefinition[],
  reviewedSessionId: string,
): ToolDefinition[] {
  const wanted = new Set<string>(SKILL_REVIEW_TOOL_NAMES);
  return allAgentTools
    .filter((t) => wanted.has(t.name))
    .map((t) => (t.name === "protocol" ? narrowProtocolToolForReview(t, { reviewedSessionId }) : t));
}

/** Test-only: drop queued reviews AND the registered deps, so fixtures can't
 *  bleed between cases and no test can accidentally drive a real model call. */
export function _resetSkillReviewQueue(): void {
  pending.clear();
  deps = null;
  passGuard.release();
  breaker.reset();
}

/** Test/debug: what is currently queued. */
export function peekSkillReviewQueue(): SkillReviewRequest[] {
  return [...pending.values()];
}
