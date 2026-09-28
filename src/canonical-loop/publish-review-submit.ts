/**
 * Pre-publish review — the second kind of fresh-context pass on the
 * verification pipeline. Where the deliverable verification (verification-
 * submit.ts) is fire-and-forget after a task ends, this one is AWAITED: the
 * publish gate (tool-execution/publish-review-gate.ts) holds a `git push` or a
 * deploy until the reviewer's verdict is in.
 *
 * Same machinery, deliberately: a normal canonical op on the user's picked
 * provider/model, sealed runtime, its own worker-scoped session
 * `agent-op-<opId>` (worker-op-runtime.ts), a token budget, and a wall-time
 * deadline. What differs, and why:
 *
 *   - BELT: read, grep, glob only — no shell, no writes, no web. The reviewer
 *     judges code; it has no reason to run it or reach off the machine, and a
 *     reviewer that could write would be a second agent editing the repo.
 *   - FILE BOUNDARY: the repository being published, in "workspace" mode with
 *     that repository as the workspace — the reviewer can read the whole repo
 *     for precedent and nothing outside it.
 *   - LANE: "agent" (cap 5), not "background" (cap 1). The user is waiting on
 *     this verdict; it must not queue behind a deliverable verification or a
 *     memory consolidation holding the single background slot.
 *   - NOT TRACKED to the parent session: no AGENTS card, no pending
 *     notification, no idle nudge. The verdict reaches the model as the
 *     publish call's own tool result and the user as the approval card;
 *     announcing it a second time next turn would be noise. Progress goes out
 *     as tool_progress on the publish call itself.
 *   - SINGLE-FLIGHT is per (session, change-set fingerprint), owned by the
 *     gate — not the verifier's one-per-session bound, which would make a push
 *     wait for an unrelated spreadsheet check.
 *
 * The verdict is not stored twice: the op carries its change-set fingerprint
 * (inputBindings.publishFingerprint) and its final answer lives in the op's
 * own messages, so recallPublishReview re-reads the op store after a restart.
 */
import { buildContextPack } from "../ops/context-pack-builder.js";
import { getRetryPolicy } from "../ops/heartbeat.js";
import { listRecentOps, newOpId } from "../ops/op-store.js";
import { delegatedToolsetForOp } from "../ops/tools/delegated-toolset.js";
import type { Op, OpBudget, OpVisibility } from "../ops/types.js";
import { SecurityLayer } from "../security/index.js";
import { installSessionWorkRoot } from "../workspace/paths.js";
import type { ChangeSet } from "../publish-review/change-set-types.js";
import { buildPublishReviewBrief, PUBLISH_REVIEWER_SYSTEM_PROMPT } from "./publish-review-brief.js";
import { parseReviewAnswer, REVIEW_PUBLISH_OP_TYPE, type ParsedReview } from "./publish-review-verdict.js";
import { armWorkerOpDeadline, configureWorkerOpRuntime } from "./worker-op-runtime.js";
import { extractFinalAssistantText } from "./session-bridge-extractors.js";
import { awaitCanonicalOp, canonicalLoopEntry } from "./index.js";
import { opCancel } from "./control-api.js";
import { createLogger } from "../logger.js";

const logger = createLogger("canonical-loop.publish-review");

/**
 * Budget for one review. What binds, and why these values:
 *   - maxWallTimeMs 240s BINDS twice: the worker's own wall clock (every lane,
 *     worker-wall-clock.ts) and armWorkerOpDeadline, which also covers time
 *     spent queued. Four minutes is the owner's "a few minutes": long enough
 *     for ~12 read/grep calls on a large diff at normal provider latency,
 *     short enough that a user watching a push is not left wondering.
 *   - maxTokens 250k BINDS as a stop (checkpoint-stop.ts). The meter is
 *     cumulative: the first turn carries ~10k tokens of diff plus the
 *     mandate, and each read adds to every later turn, so twelve turns land
 *     near 200k. Below that the reviewer would be stopped mid-investigation
 *     and answer nothing (FAILED); well above it only buys a runaway.
 *   - maxIterations 16 is the worker lanes' checkpoint cadence, not a cap.
 */
export const PUBLISH_REVIEW_OP_BUDGET: OpBudget = {
  maxIterations: 16,
  maxTokens: 250_000,
  maxWallTimeMs: 240_000,
  maxSelfEditCalls: 0,
};

/** How long past the deadline the gate waits for the cancel to land. */
const AWAIT_GRACE_MS = 15_000;

let deadlineMsOverride: number | null = null;

/** Test-only: shorten the review deadline (the real loop needs real timers). */
export function _setPublishReviewDeadlineMsForTests(ms: number | null): void {
  deadlineMsOverride = ms;
}

const REVIEWER_TOOLS: ReadonlySet<string> = new Set(["read", "grep", "glob"]);

export interface PublishReviewRequest {
  changeSet: ChangeSet;
  /** The chat/job session whose call is being gated. */
  sessionId: string;
  /** The op making the publish call (lineage only). */
  parentOpId?: string;
  /** The publish call's turn was stopped — cancel the review with it. */
  signal?: AbortSignal;
}

export interface PublishReviewRun {
  opId?: string;
  parsed: ParsedReview;
}

export function publishReviewRuntimeSessionId(opId: string): string {
  return `agent-op-${opId}`;
}

/** The repository the review reads: the first part's root. Every part of one
 *  command lives in the repository its cwd resolved to, and the gate only
 *  submits when at least one part is known. */
function reviewRoot(changeSet: ChangeSet): string {
  const root = changeSet.parts[0]?.repoRoot;
  if (!root) throw new Error("nothing reviewable in the change set");
  return root;
}

export async function buildPublishReviewOp(req: PublishReviewRequest): Promise<Op> {
  const task = buildPublishReviewBrief(req.changeSet);
  const contextPack = await buildContextPack({
    description: task,
    lane: "agent",
    budget: { ...PUBLISH_REVIEW_OP_BUDGET },
  });
  // buildContextPack anchors AGENTS.md collection at THIS app's install, which
  // says nothing about the user's repository; the reviewer reads the repo's
  // own conventions from disk instead.
  contextPack.context.agentsRules = "";
  return {
    id: newOpId(`op_${REVIEW_PUBLISH_OP_TYPE}`),
    sessionId: req.sessionId,
    type: REVIEW_PUBLISH_OP_TYPE,
    task,
    contextPack,
    lane: "agent",
    retryPolicy: getRetryPolicy(REVIEW_PUBLISH_OP_TYPE),
    ownerId: "local-user",
    visibility: "private" as OpVisibility,
    status: "pending",
    createdAt: new Date().toISOString(),
    attemptCount: 0,
    ...(req.parentOpId ? { parentOpId: req.parentOpId } : {}),
    taskProvenance: "harness",
    inputBindings: { publishFingerprint: req.changeSet.fingerprint },
  };
}

function reviewerBelt() {
  const tools = delegatedToolsetForOp("background").filter((t) => REVIEWER_TOOLS.has(t.name));
  if (tools.length === 0) throw new Error("the read-only review tools (read, grep, glob) are not registered");
  return tools;
}

/**
 * Submit the review and wait for its verdict. Never throws: every way it can
 * go wrong is a `{ ok: false, reason }` the gate reports as FAILED.
 */
export async function runPublishReview(req: PublishReviewRequest): Promise<PublishReviewRun> {
  let op: Op;
  // The reviewer's relative paths (and grep/glob's default search base) anchor
  // at the repository under review, the same folder its file boundary allows.
  let disposeWorkRoot = () => {};
  try {
    op = await buildPublishReviewOp(req);
    const root = reviewRoot(req.changeSet);
    disposeWorkRoot = installSessionWorkRoot(publishReviewRuntimeSessionId(op.id), root);
    // Runtime before visibility: an unresolvable provider leaves no ghost op.
    await configureWorkerOpRuntime(op, publishReviewRuntimeSessionId(op.id), {
      tools: reviewerBelt(),
      systemPrompt: PUBLISH_REVIEWER_SYSTEM_PROMPT,
      security: new SecurityLayer(root, "workspace"),
    });
    canonicalLoopEntry(op, { sessionId: req.sessionId, confirmRunning: false });
  } catch (e) {
    disposeWorkRoot();
    logger.warn(`[publish-review] could not start a review: ${(e as Error).message}`);
    return { parsed: { ok: false, reason: `the review could not start: ${(e as Error).message}` } };
  }
  const opId = op.id;
  const deadline = deadlineMsOverride ?? PUBLISH_REVIEW_OP_BUDGET.maxWallTimeMs;
  armWorkerOpDeadline(opId, deadline, "publish-review");
  const onAbort = () => { opCancel(opId, "publish-call-stopped"); };
  req.signal?.addEventListener("abort", onAbort, { once: true });
  logger.info(`[publish-review] submitted ${opId} for ${req.changeSet.fingerprint.slice(0, 12)} (session ${req.sessionId})`);
  try {
    const result = await awaitCanonicalOp(opId, deadline + AWAIT_GRACE_MS);
    if (!result) return { opId, parsed: { ok: false, reason: `the review did not finish within ${Math.round(deadline / 60_000)} minutes` } };
    if (result.status === "cancelled") {
      return { opId, parsed: { ok: false, reason: req.signal?.aborted ? "the turn was stopped during the review" : `the review ran past its ${Math.round(deadline / 60_000)}-minute deadline and was cancelled` } };
    }
    if (result.status === "failed") return { opId, parsed: { ok: false, reason: `the review failed: ${result.error?.message ?? result.finalSummary}` } };
    const parsed = parseReviewAnswer(extractFinalAssistantText(opId, 24_000));
    if (!parsed.ok && result.status === "partial") {
      return { opId, parsed: { ok: false, reason: `the review hit its budget before answering (${parsed.reason})` } };
    }
    return { opId, parsed };
  } finally {
    req.signal?.removeEventListener("abort", onAbort);
    disposeWorkRoot();
  }
}

/** Sessions whose past reviews have been read back from the op store in this
 *  process — the disk scan runs once per session, not on every miss. */
const RECALLED_SESSIONS = new Set<string>();

/**
 * A verdict this session already has for this exact change set, from a review
 * that ran before this process started. Only a parseable verdict is recalled:
 * a FAILED review is not a verdict, and the next attempt reviews again.
 */
export function recallPublishReviews(sessionId: string): Array<{ fingerprint: string; opId: string; parsed: ParsedReview & { ok: true } }> {
  if (RECALLED_SESSIONS.has(sessionId)) return [];
  RECALLED_SESSIONS.add(sessionId);
  const found: Array<{ fingerprint: string; opId: string; parsed: ParsedReview & { ok: true } }> = [];
  for (const op of listRecentOps(500)) {
    if (op.type !== REVIEW_PUBLISH_OP_TYPE || op.sessionId !== sessionId) continue;
    if (op.canonical?.state !== "succeeded") continue;
    const fingerprint = op.inputBindings?.publishFingerprint;
    if (!fingerprint) continue;
    const parsed = parseReviewAnswer(extractFinalAssistantText(op.id, 24_000));
    if (parsed.ok) found.push({ fingerprint, opId: op.id, parsed });
  }
  return found;
}

/** Test-only: forget which sessions were recalled. */
export function _resetPublishReviewRecallForTests(): void {
  RECALLED_SESSIONS.clear();
}
