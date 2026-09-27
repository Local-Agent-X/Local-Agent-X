/**
 * Skill-review queue — what is waiting to be reviewed, and when it may be.
 *
 * A review judges whether a turn PROVED a procedure, which cannot be known at
 * the moment the turn ends: the user may revert the work, correct it, or build
 * on it next. So a queued review is deferred until its outcome can be read —
 * the same session sent a newer message (its turn committed), or the settle
 * period passed with nothing newer. The drain then renders the reviewed op
 * together with those later turns' user messages.
 *
 * Split from skill-review.ts, which owns the run. This module imports nothing
 * from the canonical loop, so the turn loop can enqueue without an ESM cycle.
 */

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

/** How long a finished turn waits for its outcome when the user sends nothing
 *  newer in that session. */
export const SKILL_REVIEW_SETTLE_MS = 30 * 60 * 1000;

/** Ceiling on queued reviews. Oldest is dropped past this. */
const MAX_PENDING = 20;

export interface SkillReviewRequest {
  /** Session whose turn is under review — the proposal's provenance. */
  sessionId: string;
  /** The op whose committed turn is under review. */
  opId: string;
  /** Ordered tool names for the whole op (collectToolSequence output). */
  toolSequence: readonly string[];
  queuedAt: number;
  /** Later interactive ops in the same session. Their user messages are how
   *  the review learns whether the work held up. */
  followUpOpIds: string[];
}

export interface SkillReviewRequestInput {
  sessionId: string;
  opId: string;
  toolSequence: readonly string[];
  now?: number;
}

export type SkillReviewQueueResult =
  | { queued: true }
  | { queued: false; reason: "trivial" | "no-op" | "self-review" | "no-session" };

/**
 * Own coalescer state, keyed by session (campaign D3). The memory end-of-turn
 * pass keeps its own; a single shared pending slot would let whichever fired
 * last starve the other.
 */
const pending = new Map<string, SkillReviewRequest>();

/** True when the turn did enough tool work to plausibly contain a procedure.
 *  Total-tolerant: the turn loop calls this, where a throw would break the
 *  user's turn, so a malformed sequence is "not worthy", not a crash. */
export function isReviewWorthy(toolSequence: readonly string[] | undefined): boolean {
  if (!Array.isArray(toolSequence)) return false;
  if (toolSequence.length < MIN_TOOL_CALLS_FOR_REVIEW) return false;
  return new Set(toolSequence).size >= MIN_DISTINCT_TOOLS_FOR_REVIEW;
}

/**
 * Entry point for the turn-loop trigger. Cheap and synchronous: it gates and
 * enqueues; it never renders or runs a model.
 *
 * Latest turn wins for a given session. The newest op's conversation carries
 * the earlier turns as history, followed by what the user said about them, so
 * reviewing it subsumes reviewing an earlier slice — and the newer turn is
 * itself deferred until ITS outcome is known.
 */
export function requestSkillReview(request: SkillReviewRequestInput): SkillReviewQueueResult {
  const sessionId = typeof request?.sessionId === "string" ? request.sessionId.trim() : "";
  if (!sessionId) return { queued: false, reason: "no-session" };
  if (sessionId.startsWith(SKILL_REVIEW_SESSION_PREFIX)) return { queued: false, reason: "self-review" };
  const opId = typeof request.opId === "string" ? request.opId.trim() : "";
  if (!opId) return { queued: false, reason: "no-op" };
  if (!isReviewWorthy(request.toolSequence)) return { queued: false, reason: "trivial" };

  pending.delete(sessionId);
  pending.set(sessionId, {
    sessionId,
    opId,
    toolSequence: [...request.toolSequence],
    queuedAt: request.now ?? Date.now(),
    followUpOpIds: [],
  });
  while (pending.size > MAX_PENDING) {
    const oldest = pending.keys().next();
    if (oldest.done) break;
    pending.delete(oldest.value);
  }
  return { queued: true };
}

/** A user turn committed in `sessionId`. A review already waiting on that
 *  session now has its outcome evidence and becomes eligible. */
export function noteSessionTurn(sessionId: string, opId: string): void {
  const request = pending.get(sessionId);
  if (!request || request.opId === opId || request.followUpOpIds.includes(opId)) return;
  request.followUpOpIds.push(opId);
}

export function isReviewEligible(request: SkillReviewRequest, now = Date.now()): boolean {
  return request.followUpOpIds.length > 0 || now - request.queuedAt >= SKILL_REVIEW_SETTLE_MS;
}

/** Remove and return up to `limit` eligible reviews, oldest first. Ineligible
 *  ones keep their place. */
export function takeEligibleReviews(limit: number, now = Date.now()): SkillReviewRequest[] {
  const batch: SkillReviewRequest[] = [];
  for (const [key, request] of pending) {
    if (batch.length >= limit) break;
    if (!isReviewEligible(request, now)) continue;
    pending.delete(key);
    batch.push(request);
  }
  return batch;
}

export function pendingReviewCount(): number {
  return pending.size;
}

/** Test/debug: what is currently queued. */
export function peekSkillReviewQueue(): SkillReviewRequest[] {
  return [...pending.values()].map((r) => ({ ...r, followUpOpIds: [...r.followUpOpIds] }));
}

export function _clearSkillReviewQueue(): void {
  pending.clear();
}
