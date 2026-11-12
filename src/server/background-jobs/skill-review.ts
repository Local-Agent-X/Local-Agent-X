/**
 * Skill review — the post-turn procedural-learning fork.
 *
 * After a turn does non-trivial tool work, the conversation is replayed to a
 * background fork that asks itself one question: did this turn prove a
 * reusable procedure? If it did, the fork proposes it as a learned procedure
 * for the user to keep or discard.
 *
 * Why this exists: the same workflow was run 3+ times and captured 3+ times —
 * every time into the DECLARATIVE store (158 facts, several of them the
 * procedure written out longhand as observations) and never once into the
 * PROCEDURAL one. It came back as loose prose ranked by similarity instead of
 * an ordered playbook. This job closes that gap.
 *
 * Queued reviews are deferred until the turn's outcome can be read and drained
 * with the user's later messages (skill-review-queue.ts). The fork proposes
 * learned-procedure DRAFTS only (skill-review-tool.ts); nothing it does reaches
 * the live catalog until the user keeps it or independent evidence promotes it.
 *
 * Shape follows dream-check.ts: runAgentViaCanonical on lane "background", a
 * hand-filtered tool list, its own static prompt, a synthetic sessionId. No
 * FieldAgent, no AgentRunStore row — a review must be invisible to the AGENTS
 * panel. Its one broadcast is the learning notice, to the reviewed session only. Deliberately NOT agents/invoke.ts, which
 * broadcasts spawn/token/complete events to every client unconditionally and
 * silently discards a tool override when a templateId resolves.
 *
 * This file owns the run. The queue lives in skill-review-queue.ts, the prompt
 * in skill-review-prompt.ts, the narrowed tool in skill-review-tool.ts, and the
 * failure breaker in skill-review-breaker.ts.
 */
import { SecurityLayer } from "../../security/index.js";
import type { LAXConfig, ServerEvent, ToolDefinition } from "../../types.js";
import type { SecretsStore } from "../../secrets.js";
import type { ToolPolicy } from "../../tool-policy/index.js";
import { createLogger } from "../../logger.js";
import { createOverlapGuard } from "../scheduler.js";
import { SkillReviewBreaker, type SkillReviewBreakerState } from "./skill-review-breaker.js";
import {
  SKILL_REVIEW_TOOL_NAMES,
  buildSkillReviewMessage,
  buildSkillReviewSystemPrompt,
} from "./skill-review-prompt.js";
import { narrowProtocolToolForReview, type ReviewProtocolToolContext } from "./skill-review-tool.js";
import { projectNamesTouchedBy } from "./skill-review-project-names.js";
import {
  SKILL_REVIEW_SESSION_PREFIX,
  _clearSkillReviewQueue,
  pendingReviewCount,
  takeEligibleReviews,
  type SkillReviewRequest,
} from "./skill-review-queue.js";
import { renderOpTranscript, TRANSCRIPT_CHAR_CAP } from "../../canonical-loop/public/op-transcript.js";
import { broadcastToSession } from "../../ops/session-bridge.js";
import { OP_TYPE } from "../../ops/op-types.js";
import { DEFAULT_REVIEW_TIMEOUT_MS, reviewFailure, runReviewFork } from "./review-fork.js";

const logger = createLogger("server.background-jobs.skill-review");

/** Scheduler poll cadence — one value for the ./index.ts registration and
 *  the breaker's backoff base, so the two cannot drift. */
export const SKILL_REVIEW_POLL_INTERVAL_MS = 5 * 60 * 1000; // 5min

/** Reviews drained per scheduler tick. Bounds the cost of a burst. */
const MAX_REVIEWS_PER_PASS = 3;

export interface SkillReviewDeps {
  config: LAXConfig;
  dataDir: string;
  secretsStore: SecretsStore;
  security: SecurityLayer;
  toolPolicy: ToolPolicy;
  allAgentTools: ToolDefinition[];
  /** Per-review wall-clock ceiling. Defaults to DEFAULT_REVIEW_TIMEOUT_MS (review-fork.ts). */
  timeoutMs?: number;
  /** Renders the reviewed op plus its follow-up turns. Defaults to the
   *  canonical op-transcript renderer. */
  renderTranscript?: (opId: string, followUpOpIds: readonly string[]) => string;
  /** Delivers a learning notice to the reviewed session. Defaults to the
   *  session bridge. */
  notify?: (sessionId: string, event: ServerEvent) => void;
  /** Projects the reviewed op worked in. Defaults to reading the op's own
   *  tool-call paths (skill-review-project-names.ts). */
  projectNamesFor?: (opId: string) => string[];
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
  reason?: "no-runner" | "empty" | "waiting" | "in-flight" | "breaker-backoff" | "parked";
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
    if (pendingReviewCount() === 0) return { reviewed: 0, failed: 0, skipped: false, reason: "empty" };
    const batch = takeEligibleReviews(MAX_REVIEWS_PER_PASS);
    if (batch.length === 0) return { reviewed: 0, failed: 0, skipped: false, reason: "waiting" };

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
  const forkSessionId = `${SKILL_REVIEW_SESSION_PREFIX}${Date.now()}-${reviewSeq++}`;
  const notify = d.notify ?? broadcastToSession;
  const tools = buildReviewTools(d.allAgentTools, {
    reviewedSessionId: request.sessionId,
    toolSequence: request.toolSequence,
    projectNames: (d.projectNamesFor ?? projectNamesTouchedBy)(request.opId),
    onProposed: (sessionId, notice) => notify(sessionId, { type: "learning_notice", ...notice }),
  });
  if (tools.length === 0) {
    throw new Error(`no review tools resolved (expected ${SKILL_REVIEW_TOOL_NAMES.join(", ")})`);
  }

  const render = d.renderTranscript ?? ((opId, followUps) => renderOpTranscript(opId, TRANSCRIPT_CHAR_CAP, followUps));
  const transcript = render(request.opId, request.followUpOpIds);
  if (!transcript.trim()) throw new Error(`no transcript could be rendered for op ${request.opId}`);
  // The inventory is what lets the fork tell "already native" from "had to be
  // found". Rendered from the same registry the agent runs with, never a
  // hand-kept list, and deterministic so forks share the cached prefix.
  const systemPrompt = buildSkillReviewSystemPrompt(d.allAgentTools);

  logger.info(`[skill-review] Reviewing session ${request.sessionId} (${request.toolSequence.length} tool calls, ${request.followUpOpIds.length} later turns)`);
  const outcome = await runReviewFork({
    forkSessionId,
    message: buildSkillReviewMessage({
      sessionId: request.sessionId,
      toolSequence: request.toolSequence,
      transcript,
    }),
    systemPrompt,
    section: { id: "skill-review", label: "Protocol Review" },
    tools,
    opType: OP_TYPE.skillReview,
    maxIterations: 12,
    timeoutMs: d.timeoutMs ?? DEFAULT_REVIEW_TIMEOUT_MS,
  }, d);

  const wrote = outcome.messages.filter(
    (m) => m.role === "assistant" && Array.isArray((m as { tool_calls?: unknown[] }).tool_calls),
  ).length;
  const failure = reviewFailure(outcome);
  if (failure) {
    throw new Error(`fork ${forkSessionId} ${failure} after ${wrote} tool-calling turns`);
  }
  logger.info(`[skill-review] Session ${request.sessionId} reviewed (${wrote} tool-calling turns)`);
}

/**
 * Resolve the fork's tools from the live registry (so policy wrapping and
 * lineage instrumentation are preserved) and narrow `protocol` to the review
 * surface. Exported for the allowlist test — the recursion guard is a property
 * of this list and nothing else.
 */
export function buildReviewTools(
  allAgentTools: readonly ToolDefinition[],
  ctx: ReviewProtocolToolContext,
): ToolDefinition[] {
  const wanted = new Set<string>(SKILL_REVIEW_TOOL_NAMES);
  return allAgentTools
    .filter((t) => wanted.has(t.name))
    .map((t) => (t.name === "protocol" ? narrowProtocolToolForReview(t, ctx) : t));
}

/** Test-only: drop queued reviews AND the registered deps, so fixtures can't
 *  bleed between cases and no test can accidentally drive a real model call. */
export function _resetSkillReviewQueue(): void {
  _clearSkillReviewQueue();
  deps = null;
  passGuard.release();
  breaker.reset();
}
