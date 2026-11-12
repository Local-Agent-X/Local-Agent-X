/**
 * Failure review — the out-of-band look at what keeps going wrong.
 *
 * A tool call that failed the same way in several chats (failure-patterns.ts)
 * is read back from the runs it happened in, and a fork decides one thing
 * about it: is there something an agent meeting it again should be told? The
 * answer is a lesson for the user to keep or discard, a note that the tool
 * itself falls short, or nothing.
 *
 * Why this exists: every chat met a recurring failure new. The loop notices a
 * repeat inside one run (constraint-ledger.ts) and the skill review reads one
 * finished turn; nothing looked across chats, so the same wrong first move was
 * made, failed and recovered from again and again.
 *
 * What bounds it:
 *  - The counting is arithmetic over the usage log. A pass with nothing
 *    recurring, or nothing new, makes no model call at all.
 *  - At most one pass a day, MAX_REVIEWS_PER_PASS failures per pass, on the
 *    shared foreground-idle gate, each fork under review-fork.ts's timeout.
 *  - The fork has no tools. Its reply is one JSON object; this file decides
 *    what is stored.
 *  - A lesson is `proposed` until the user keeps it (known-failures.ts).
 *
 * A refused call (`blocked`) is counted and listed but never reviewed: the
 * refusal already carries what to do instead, and a model-written "lesson"
 * about a gate is one sentence away from advice on getting around it.
 */
import type { AgentTurn } from "../../types.js";
import { getRuntimeConfig } from "../../config.js";
import { createLogger } from "../../logger.js";
import { OP_TYPE } from "../../ops/op-types.js";
import { readToolFailures } from "../../tool-execution/tool-usage-telemetry.js";
import { renderFailureEvidence, type FailureEvidence } from "../../canonical-loop/public/op-tool-failures.js";
import {
  failureWindowStart, recurringFailures, type FailurePattern,
} from "../../cognition/cross-session-learning/failure-patterns.js";
import {
  lastFailureReviewAt, listKnownFailures, needsReview, noteFailureReviewRan, recordFailureReview,
  type KnownFailure, type ReviewVerdict,
} from "../../cognition/cross-session-learning/known-failures.js";
import { appendCapabilityGap, MAX_GAP_SUMMARY_CHARS } from "../../cognition/cross-session-learning/capability-gaps.js";
import { inboxLessonProposed } from "../../inbox/producers.js";
import { DEFAULT_REVIEW_TIMEOUT_MS, reviewFailure, runReviewFork, type ReviewForkDeps } from "./review-fork.js";
import {
  FAILURE_REVIEW_SESSION_PREFIX, FAILURE_REVIEW_SYSTEM_PROMPT, buildFailureReviewMessage, parseFailureVerdict,
} from "./failure-review-prompt.js";

const logger = createLogger("server.background-jobs.failure-review");

/** The job is polled hourly so a busy machine still finds an idle hour; this
 *  is what makes it a daily review. */
export const FAILURE_REVIEW_MIN_GAP_MS = 20 * 60 * 60 * 1000;
/** Failures reviewed per pass. Bounds the cost of a bad week. */
export const MAX_REVIEWS_PER_PASS = 5;
/** Occurrences shown to the fork, one per chat, newest first. */
const MAX_SAMPLES = 4;
/** Reviews that may fail in a row before the pass gives up: the provider is
 *  down or refusing, and the remaining reviews would fail the same way. */
const MAX_FAILURES_IN_A_ROW = 2;

export interface FailureReviewDeps extends ReviewForkDeps {
  /** Per-review wall-clock ceiling. Defaults to DEFAULT_REVIEW_TIMEOUT_MS. */
  timeoutMs?: number;
  now?: () => number;
  /** The recurring failures as of `now`. Defaults to the usage log. */
  recurring?: (now: number) => Promise<FailurePattern[]>;
  /** One failure as the fork reads it. Defaults to the op store. */
  evidenceFor?: (opId: string, toolCallId: string) => FailureEvidence | null;
  /** Defaults to runReviewFork. */
  runFork?: typeof runReviewFork;
  /** Tells the user a lesson is waiting. Defaults to the inbox and the open tabs. */
  onProposed?: (lesson: KnownFailure) => void;
}

let deps: FailureReviewDeps | null = null;

/** Capture the heavy server deps so the scheduler can drive a pass without
 *  holding them. Mirrors registerSkillReviewRunner. */
export function registerFailureReviewRunner(next: FailureReviewDeps): void {
  deps = next;
  logger.info("[failure-review] Runner registered");
}

export interface FailureReviewPassResult {
  reviewed: number;
  proposed: number;
  failed: number;
  skipped: boolean;
  reason?: "no-runner" | "disabled" | "recent";
}

const skipped = (reason: FailureReviewPassResult["reason"]): FailureReviewPassResult =>
  ({ reviewed: 0, proposed: 0, failed: 0, skipped: true, reason });

async function recurringFromLog(now: number): Promise<FailurePattern[]> {
  return recurringFailures(await readToolFailures(failureWindowStart(now)), now);
}

/**
 * One pass: find the recurring failures nothing has been decided about and
 * review up to MAX_REVIEWS_PER_PASS of them. `force` skips the once-a-day
 * gate (a manual run), never the switch.
 */
export async function runFailureReviewPass(options: { force?: boolean } = {}): Promise<FailureReviewPassResult> {
  if (!deps) return skipped("no-runner");
  const d = deps;
  if (!getRuntimeConfig().failureReviewEnabled) return skipped("disabled");
  const now = (d.now ?? Date.now)();
  if (!options.force && now - lastFailureReviewAt() < FAILURE_REVIEW_MIN_GAP_MS) return skipped("recent");

  const known = new Map(listKnownFailures().map((k) => [k.signature, k]));
  const due = (await (d.recurring ?? recurringFromLog)(now))
    .filter((p) => p.status !== "blocked" && needsReview(p, known.get(p.signature)))
    .slice(0, MAX_REVIEWS_PER_PASS);
  // Stamped whether or not anything was due: the log is read once a day.
  noteFailureReviewRan(now);

  const result: FailureReviewPassResult = { reviewed: 0, proposed: 0, failed: 0, skipped: false };
  let failuresInARow = 0;
  for (const pattern of due) {
    if (failuresInARow >= MAX_FAILURES_IN_A_ROW) break;
    try {
      const stored = await reviewPattern(pattern, d, now);
      if (!stored) continue;
      result.reviewed++;
      failuresInARow = 0;
      if (stored.state === "proposed") {
        result.proposed++;
        (d.onProposed ?? announceLesson)(stored);
      }
    } catch (e) {
      // Never swallow: a review that dies silently is a learning loop that
      // looks healthy and does nothing. The failure stays unreviewed and is
      // picked up by the next pass.
      result.failed++;
      failuresInARow++;
      logger.warn(`[failure-review] Review of ${pattern.tool} (${pattern.signature}) failed: ${(e as Error).message}`);
    }
  }
  return result;
}

let reviewSeq = 0;

/** The fork's final words. Shape-tolerant: content is a string or text parts. */
function finalReply(outcome: AgentTurn): string {
  for (let i = outcome.messages.length - 1; i >= 0; i--) {
    const message = outcome.messages[i];
    if (message.role !== "assistant") continue;
    const content = message.content;
    const text = typeof content === "string"
      ? content
      : Array.isArray(content) ? content.map((part) => (part as { text?: unknown }).text).filter((t) => typeof t === "string").join("") : "";
    if (text.trim()) return text;
  }
  return "";
}

/**
 * A lesson says what worked instead. With no sample in which the same work
 * then succeeded, nothing shows that anything did: the verdict is held as
 * noise, to be looked at again if the failure spreads. Enforced here, not left
 * to the prompt.
 */
function requireRecovery(verdict: ReviewVerdict, evidence: readonly FailureEvidence[]): ReviewVerdict {
  if (verdict.verdict !== "lesson" || evidence.some((e) => e.recovered)) return verdict;
  return { verdict: "noise", why: `No sample shows the same call succeeding afterwards, so nothing is proven to work instead. (${verdict.why})` };
}

/** Review one recurring failure. Null when its runs no longer hold the calls. */
async function reviewPattern(pattern: FailurePattern, d: FailureReviewDeps, now: number): Promise<KnownFailure | null> {
  const evidenceFor = d.evidenceFor ?? renderFailureEvidence;
  const evidence = pattern.samples.slice(0, MAX_SAMPLES)
    .map((s) => (s.toolCallId ? evidenceFor(s.opId, s.toolCallId) : null))
    .filter((e): e is FailureEvidence => e !== null);
  if (evidence.length === 0) return null;

  const forkSessionId = `${FAILURE_REVIEW_SESSION_PREFIX}${now}-${reviewSeq++}`;
  logger.info(`[failure-review] Reviewing ${pattern.tool} "${pattern.reason}" (${pattern.sessions} chats, ${evidence.length} samples)`);
  const outcome = await (d.runFork ?? runReviewFork)({
    forkSessionId,
    message: buildFailureReviewMessage(pattern, evidence.map((e) => e.text)),
    systemPrompt: FAILURE_REVIEW_SYSTEM_PROMPT,
    section: { id: "failure-review", label: "Failure Review" },
    tools: [],
    opType: OP_TYPE.failureReview,
    maxIterations: 2,
    timeoutMs: d.timeoutMs ?? DEFAULT_REVIEW_TIMEOUT_MS,
  }, d);
  const failure = reviewFailure(outcome);
  if (failure) throw new Error(`fork ${forkSessionId} ${failure}`);
  const verdict = parseFailureVerdict(finalReply(outcome));
  if (!verdict) throw new Error(`fork ${forkSessionId} did not reply with a verdict`);

  const stored = recordFailureReview(pattern, requireRecovery(verdict, evidence), now);
  if (stored.verdict === "app_gap") {
    const tool = pattern.action ? `${pattern.tool} (${pattern.action})` : pattern.tool;
    appendCapabilityGap({
      sessionId: pattern.samples[0]?.sessionId ?? "",
      timestamp: now,
      summary: `${tool} keeps failing: ${pattern.reason}. ${stored.why}`.slice(0, MAX_GAP_SUMMARY_CHARS),
      toolsTried: [pattern.tool],
    });
  }
  logger.info(`[failure-review] ${pattern.tool} (${pattern.signature}): ${stored.verdict}`);
  return stored;
}

function announceLesson(lesson: KnownFailure): void {
  inboxLessonProposed({ signature: lesson.signature, tool: lesson.tool, lesson: lesson.lesson ?? "", sessions: lesson.sessions });
  void import("../../chat-ws/index.js")
    .then(({ broadcastAll }) => broadcastAll({ type: "settings_changed", settings: { recurringProblems: true } }))
    .catch(() => { /* no socket server (tests, a headless run): the list re-reads when it is next opened */ });
}

/** Test-only: drop the registered deps so no test can drive a real model call. */
export function _resetFailureReview(): void {
  deps = null;
  reviewSeq = 0;
}
