/**
 * The pre-publish review gate. Before a tool call that PUBLISHES — a git push,
 * a deploy, a package publish, a release (publish-operation.ts) — is decided
 * by the approval phase, a fresh-context model reviews exactly what it would
 * ship (publish-review/change-set.ts → canonical-loop/publish-review-submit.ts)
 * and the verdict drives what happens next:
 *
 *   RED       blocked. The model gets the findings as the tool result so it can
 *             fix them. In an interactive run the user also gets a card with
 *             the findings and a "Push anyway" override (alwaysAsk, registered
 *             in approval-overrides.ts); approving runs the original call and
 *             records the override in the audit trail. Unattended: no override.
 *   FAILED / UNKNOWN, or AMBER / GREEN with another publish in the call
 *             that could not be reviewed
 *             nothing (or not all of it) was reviewed, and nothing ships
 *             unreviewed in ANY profile without the user's explicit yes (the
 *             owner's rule, 2026-09-28, after a live UNKNOWN under Power let a
 *             push out): the same always-ask card, worded "Push unreviewed",
 *             audited the same way; unattended: blocked.
 *   AMBER / GREEN covering every publish in the call, EMPTY
 *             the profile's "publish" row decides (requireApprovalPhase); a
 *             card, if one is raised, carries the review, and the tool result
 *             carries it either way.
 *
 * Verdicts are cached per (session, change-set fingerprint): a retry of the
 * same push, or the same push after an override, reuses the verdict; any
 * change to what would ship is a new fingerprint and a new review. One review
 * runs at a time per (session, fingerprint) — concurrent identical publishes
 * share it. After a restart the op store supplies earlier verdicts.
 *
 * The wait is the user's time, not the tool's: it is banked with
 * beginApprovalWait, so a publish dispatched inside another tool's execute
 * (whose runner timeout would otherwise count it) is not timed out by the
 * review. Progress goes out as tool_progress on the publish call.
 */
import { USER_HINTS, type ToolResult } from "../types.js";
import { getApprovalManager } from "../approval-manager.js";
import { beginApprovalWait } from "../approval-wait.js";
import { getSharedAuditTrail } from "../threat/audit-trail.js";
import { getLaxDir } from "../lax-data-dir.js";
import type { PublishOperation } from "../publish-operation.js";
import { changeSetIsEmpty, type ChangeSet } from "../publish-review/change-set-types.js";
import type { PublishReview, PublishReviewRequest, PublishReviewRun } from "../canonical-loop/public/publish-review.js";
import type { ToolCallContext } from "./context.js";
import { needsOverride, reviewCardContext, reviewNoteForModel, reviewPreview, stopText } from "./publish-review-text.js";
import { createLogger } from "../logger.js";

const logger = createLogger("tool-execution.publish-review-gate");

export type PublishGateOutcome =
  | { kind: "block"; result: ToolResult }
  | { kind: "proceed"; review: PublishReview; overridden: boolean };

interface GateDeps {
  computeChangeSet: (ops: PublishOperation[]) => Promise<ChangeSet>;
  runReview: (req: PublishReviewRequest) => Promise<PublishReviewRun>;
  recall: (sessionId: string) => Array<{ fingerprint: string; opId: string; parsed: Extract<PublishReviewRun["parsed"], { ok: true }> }>;
  summarize: (cs: ChangeSet) => string;
}

async function realDeps(): Promise<GateDeps> {
  const [{ computeChangeSet }, review] = await Promise.all([
    import("../publish-review/change-set.js"),
    import("../canonical-loop/public/publish-review.js"),
  ]);
  return { computeChangeSet, runReview: review.runPublishReview, recall: review.recallPublishReviews, summarize: review.summarizeChangeSet };
}

let depsOverride: Partial<GateDeps> | null = null;

/** How often a waiting publish reports that its review is still running. */
export const PROGRESS_INTERVAL_MS = 20_000;

/** sessionId → fingerprint → verdict (RED / AMBER / GREEN only). */
const VERDICTS = new Map<string, Map<string, PublishReview>>();
/** `${sessionId}::${fingerprint}` → the review in flight. */
const IN_FLIGHT = new Map<string, Promise<PublishReview>>();

function cached(sessionId: string, fingerprint: string, deps: GateDeps): PublishReview | undefined {
  let bucket = VERDICTS.get(sessionId);
  if (!bucket) { bucket = new Map(); VERDICTS.set(sessionId, bucket); }
  for (const r of deps.recall(sessionId)) {
    if (!bucket.has(r.fingerprint)) {
      bucket.set(r.fingerprint, { status: r.parsed.verdict, findings: r.parsed.findings, opId: r.opId, fingerprint: r.fingerprint, summary: "", unknown: [] });
    }
  }
  return bucket.get(fingerprint);
}

async function reviewFor(ctx: ToolCallContext, changeSet: ChangeSet, deps: GateDeps): Promise<PublishReview> {
  const sessionId = ctx.sessionId || "default";
  const summary = deps.summarize(changeSet);
  const unknown = changeSet.unknown.map(({ label, reason }) => ({ label, reason }));
  const base = { fingerprint: changeSet.fingerprint, summary, unknown };
  if (changeSet.parts.length === 0) {
    return { ...base, status: "UNKNOWN", findings: [], reason: unknown.map((u) => u.reason).join("; ") };
  }
  if (changeSetIsEmpty(changeSet)) return { ...base, status: "EMPTY", findings: [] };

  const hit = cached(sessionId, changeSet.fingerprint, deps);
  if (hit) return { ...hit, ...base, cached: true };
  const key = `${sessionId}::${changeSet.fingerprint}`;
  const running = IN_FLIGHT.get(key);
  if (running) return running;

  const review = (async (): Promise<PublishReview> => {
    const run = await deps.runReview({ changeSet, sessionId, parentOpId: ctx.operationId, signal: ctx.signal });
    if (!run.parsed.ok) return { ...base, status: "FAILED", findings: [], reason: run.parsed.reason, ...(run.opId ? { opId: run.opId } : {}) };
    const verdict: PublishReview = { ...base, status: run.parsed.verdict, findings: run.parsed.findings, ...(run.opId ? { opId: run.opId } : {}) };
    VERDICTS.get(sessionId)?.set(changeSet.fingerprint, verdict);
    return verdict;
  })().finally(() => IN_FLIGHT.delete(key));
  IN_FLIGHT.set(key, review);
  return review;
}

function progress(ctx: ToolCallContext, message: string): void {
  try {
    ctx.onEvent?.({ type: "tool_progress", toolName: ctx.tc.name, toolCallId: ctx.tc.id, message });
  } catch { /* a dead emitter must not fail the gate */ }
}

/** Run the review for a publishing call and say what happens next. */
export async function publishReviewGate(ctx: ToolCallContext, ops: PublishOperation[]): Promise<PublishGateOutcome> {
  const complete = depsOverride?.computeChangeSet && depsOverride.runReview && depsOverride.recall && depsOverride.summarize;
  const deps: GateDeps = complete ? (depsOverride as GateDeps) : { ...(await realDeps()), ...depsOverride };
  const op = ops[0];
  const endWait = beginApprovalWait();
  const startedAt = Date.now();
  const ticker = setInterval(() => {
    progress(ctx, `Pre-publish review still running (${Math.round((Date.now() - startedAt) / 1000)}s)…`);
  }, PROGRESS_INTERVAL_MS);
  ticker.unref?.();
  let review: PublishReview;
  try {
    progress(ctx, `Working out exactly what ${op.label} would ship…`);
    const changeSet = await deps.computeChangeSet(ops);
    if (changeSet.parts.length > 0) progress(ctx, `Fresh-context review of ${deps.summarize(changeSet)}…`);
    review = await reviewFor(ctx, changeSet, deps);
  } finally {
    clearInterval(ticker);
    endWait();
  }
  progress(ctx, `Pre-publish review: ${review.status}`);
  logger.info(`[publish-gate] ${ctx.tc.name} ${op.label} → ${review.status}${review.cached ? " (cached)" : ""} fp=${review.fingerprint.slice(0, 12)}`);
  if (ctx.signal?.aborted) {
    return { kind: "block", result: { content: `NOT RUN: the turn was stopped while ${op.label} was being reviewed.`, isError: true, status: "blocked", metadata: { layer: "approval", userHint: USER_HINTS.policy } } };
  }
  if (!needsOverride(review)) return { kind: "proceed", review, overridden: false };
  return overrideOutcome(ctx, op, review);
}

function blocked(content: string, declined = false): PublishGateOutcome {
  return {
    kind: "block",
    result: {
      content,
      isError: true,
      status: declined ? "declined" : "blocked",
      metadata: { layer: "approval", userHint: declined ? USER_HINTS.declined : USER_HINTS.policy },
    },
  };
}

// A RED verdict, or no verdict at all: only the user's explicit yes on THIS
// publish lets it run.
async function overrideOutcome(ctx: ToolCallContext, op: PublishOperation, review: PublishReview): Promise<PublishGateOutcome> {
  if (ctx.callContext !== "local") return blocked(stopText(op, review, "unattended"));
  if (!ctx.onEvent) return blocked(stopText(op, review, "no-channel"));
  const outcome = await getApprovalManager().requestApprovalDetailed({
    toolName: ctx.tc.name,
    toolCallId: ctx.tc.id,
    sessionId: ctx.sessionId || "default",
    context: reviewCardContext(op, review, ctx.approvalContext),
    args: ctx.args,
    preview: reviewPreview(op, review),
    // The owner's standing instruction: nothing ships over a red review
    // finding, or with no review at all, without their explicit, per-publish
    // override (see approval-overrides.ts). No profile and no remembered
    // grant waives it.
    alwaysAsk: true,
    opId: ctx.operationId,
    emit: ctx.onEvent,
  });
  if (!outcome.approved) return blocked(stopText(op, review, outcome.reason === "declined" ? "declined" : "unanswered"), outcome.reason === "declined");
  recordOverride(ctx, op, review, outcome.grantId);
  return { kind: "proceed", review, overridden: true };
}

function recordOverride(ctx: ToolCallContext, op: PublishOperation, review: PublishReview, grantId?: string): void {
  const red = review.findings.filter((f) => f.severity === "red").map((f) => `${f.location}: ${f.problem}`);
  const unreviewed = review.unknown.map((u) => `${u.label}: ${u.reason}`).join("; ");
  const over = review.status === "RED"
    ? `over a RED pre-publish review${unreviewed ? `, with part of it not reviewed (${unreviewed})` : ""}`
    : review.status === "FAILED" || review.status === "UNKNOWN"
      ? `although the pre-publish review could not run (${review.status}: ${review.reason ?? (unreviewed || "no reason recorded")})`
      : `although part of it could not be reviewed (${unreviewed}; the rest was ${review.status})`;
  logger.warn(`[publish-gate] user approved ${op.label} ${over} (${review.fingerprint.slice(0, 12)})${red.length ? `: ${red.join("; ")}` : ""}`);
  try {
    getSharedAuditTrail(getLaxDir()).record({
      sessionId: ctx.sessionId || "default",
      event: "publish_review_overridden",
      toolName: ctx.tc.name,
      decision: "warn",
      reason: `User approved "${op.label}" ${over} (approval ${grantId ?? "?"}, review ${review.opId ?? "?"}, change set ${review.fingerprint.slice(0, 16)}).${review.status === "RED" ? ` Red findings: ${red.join("; ") || "(none listed)"}` : ""}`,
      role: "user",
      controlsApplied: ["PublishReview"],
    });
  } catch (e) {
    // The override itself stands — the user answered. The log line above
    // still carries it; say that the tamper-evident record did not land.
    logger.warn(`[publish-gate] audit record for the override failed: ${(e as Error).message}`);
  }
}

/** After a publish ran: put its review at the head of the result, where the
 *  model reads it and a size cap cannot cut it. */
export function attachPublishReviewNote(ctx: ToolCallContext): void {
  if (!ctx.publishReview || !ctx.result) return;
  ctx.result = { ...ctx.result, content: `${reviewNoteForModel(ctx.publishReview)}\n\n${ctx.result.content}` };
}

/** Test-only: replace the change-set / review / recall seams. */
export function _setPublishGateDepsForTests(deps: Partial<GateDeps> | null): void {
  depsOverride = deps;
}

/** Test-only: forget cached verdicts and in-flight reviews. */
export function _resetPublishGateForTests(): void {
  VERDICTS.clear();
  IN_FLIGHT.clear();
}
