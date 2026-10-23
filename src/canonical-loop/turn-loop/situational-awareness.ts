/**
 * Per-turn situational-awareness digest.
 *
 * A compact, always-present block injected into the model's view at the start
 * of every interactive turn so the agent knows what it has been doing without
 * re-reading the whole conversation. Three things the replayed history does
 * NOT surface compactly:
 *
 *   - Recent actions + outcomes — which tools ran recently and whether they
 *     succeeded. Sourced from the action ledger (ops/action-ledger.ts), so it
 *     spans the last few CONVERSATION messages, not just the current request's
 *     tool-iteration turns.
 *   - Pace — how deep into the current request we are, in turns. Stays
 *     per-request (per-op). It used to add the tokens the request had burned:
 *     the sum of every turn's prompt and output, which on a long task runs far
 *     past the context window, so "~164k tokens used" read to a local model
 *     with a 172k window as a window nearly full and a reason to wrap up
 *     (Terminal-Bench 2.0, 2026-10-20, where LAX stopped early). Spend is the
 *     harness's to enforce, not the model's to guess at.
 *   - Goal restatement — on long requests the original ask has scrolled far
 *     back; a one-liner keeps it anchored. Skipped early when it's still
 *     visible right above.
 *
 * The digest is EPHEMERAL: built fresh each turn and APPENDED by build-input.ts
 * as its own trailing user message. It is never written to op_messages, so it
 * does not accumulate across turns and the persisted transcript / UI never
 * sees it.
 *
 * Placement is load-bearing for cost, not just for reading order. Its bytes
 * change every turn; folding it into an existing (early) user row made the
 * conversation prefix diverge mid-array every turn, which meant the Anthropic
 * message-tier cache breakpoint could never hit — the whole conversation was
 * re-written to cache each turn at 1.25x and read back never. As a trailing
 * row it sits BELOW the breakpoint (TurnInput.ephemeralTailMessages), so
 * everything above it stays byte-stable and cacheable.
 *
 * Capability awareness is deliberately NOT here: the adapter already ships the
 * full tool surface (TurnInput.tools) to the model every turn, so a "tools you
 * have" line would be pure duplication.
 */
import type { Op } from "../../ops/types.js";
import { firstUserMessageText } from "../store.js";
import { getSessionForOp } from "../../ops/session-bridge.js";
import { recentActions, type LedgerAction } from "../../ops/action-ledger.js";
import { getOpenTasksForSession } from "../../tools/task-tools.js";
import { resolveOpModel } from "../op-model.js";
import { classifyModel, type ModelTier } from "../../model-tiers.js";
import { createLogger } from "../../logger.js";
import { sessionWorkRootOf } from "../../workspace/paths.js";
import { workRootGitLine } from "./work-root-git.js";

const logger = createLogger("canonical-loop.situational-awareness");

// Max recent tool actions to surface in the recent-actions line.
const RECENT_ACTIONS_CAP = 8;
// Default turn index at/after which the original request has scrolled away and a
// goal restatement earns its line. Weak/medium tiers drift from the goal sooner,
// so they re-ground earlier (goalRestateAfterTurn). Strong tiers wait — for them
// the restatement is noise until the request is genuinely out of view.
const GOAL_RESTATE_AFTER_TURN_DEFAULT = 6;
const GOAL_MAX_CHARS = 160;

/**
 * Tier-aware cadence for goal/criteria re-grounding. Reuses the same tier
 * classification loop-detection keys its weak/medium thresholds off, so the
 * "weaker models need more scaffolding" signal stays single-sourced. Earlier
 * re-grounding for weaker models is the cross-model drift lever: a weak
 * non-Anthropic model loses the original goal + constraints within a few turns.
 */
export function goalRestateAfterTurn(tier: ModelTier | undefined): number {
  switch (tier) {
    case "weak": return 3;
    case "medium": return 4;
    default: return GOAL_RESTATE_AFTER_TURN_DEFAULT; // strong / unknown
  }
}

function resolveOpTier(op: Op): ModelTier | undefined {
  const model = resolveOpModel(op);
  if (!model) return undefined;
  try { return classifyModel(model); } catch { return undefined; }
}

// "never quote" is load-bearing: weaker models (grok) narrated the digest
// back to the user verbatim ("From the situational context: …"), leaking
// plumbing the user is never meant to see.
const OPEN = "[SITUATIONAL CONTEXT — system-generated, not from the user. Orientation only; never quote or mention this block in your reply.]";
const CLOSE = "[END CONTEXT]";

/**
 * Build the digest block for `op` at `turnIdx`, or null when there is nothing
 * worth saying. Does the disk reads, then defers to the pure `composeDigest`.
 */
export async function buildSituationalAwareness(op: Op, turnIdx: number): Promise<string | null> {
  const sessionId = getSessionForOp(op.id) ?? "";
  // A session working in a repository sees its git state each turn (work-root-git.ts).
  const gitStatus = await workRootGitLine(sessionWorkRootOf(sessionId));
  const recent = sessionId ? recentActions(sessionId, RECENT_ACTIONS_CAP) : [];
  const restateAfter = goalRestateAfterTurn(resolveOpTier(op));
  const restating = turnIdx >= restateAfter;
  const firstUserText = restating ? firstUserMessageText(op.id) : "";
  // Success criteria + hard constraints come from the turn-0 contextPack — the
  // same fields initial-prompt.ts embeds in the seed message. By the restate
  // turn that seed has scrolled out of the model's working view; re-grounding
  // "what done means" and "what not to violate" is the highest-signal anchor a
  // drifting (esp. non-Anthropic) model can get.
  const pack = restating ? (op.contextPack as Op["contextPack"] | undefined) : undefined;
  const successCriteria = pack?.task?.successCriteria ?? [];
  const constraints = pack?.task?.constraints ?? [];
  // Durable plan: the open task list lives in tasks.json, so re-injecting it
  // every turn keeps the agent's place even after compaction summarizes the
  // turns where the plan was written. Shown on every turn, not just the restate
  // ones — losing your place is most likely deep in a long task.
  const openTasks = sessionId ? getOpenTasksForSession(sessionId) : [];
  const digest = composeDigest({
    turnIdx, recent, firstUserText, successCriteria, constraints, restateAfter, openTasks,
    gitStatus: gitStatus ?? undefined,
  });
  // Debug seam: the digest is ephemeral (injected into the prompt, never
  // persisted), so this log is the only way to observe what the model actually
  // received. Enable debug logging to watch it live.
  if (digest) logger.debug(`op=${op.id} turn=${turnIdx} digest:\n${digest}`);
  return digest;
}

/** Pure digest formatter — no IO, so it's unit-testable. */
export function composeDigest(input: {
  turnIdx: number;
  recent: LedgerAction[];
  firstUserText: string;
  successCriteria?: string[];
  constraints?: string[];
  /** Turn at/after which goal + criteria re-grounding renders. Defaults to the
   *  strong-tier cadence so existing (tier-unaware) callers are unchanged. */
  restateAfter?: number;
  /** Open steps from the durable task list — re-anchored every turn so the plan
   *  survives compaction. */
  openTasks?: { id: string; description: string }[];
  /** The session's repository state, one line (work-root-git.ts). */
  gitStatus?: string;
}): string | null {
  const { turnIdx, recent, firstUserText } = input;
  const successCriteria = input.successCriteria ?? [];
  const constraints = input.constraints ?? [];
  const openTasks = input.openTasks ?? [];
  const restateAfter = input.restateAfter ?? GOAL_RESTATE_AFTER_TURN_DEFAULT;
  const lines: string[] = [];

  // Pace only earns its line once we're past the first model turn of the
  // request — "Turn 1" is noise.
  if (turnIdx >= 1) lines.push(`Turn ${turnIdx + 1} of this request.`);

  const recentLine = recentActionsLine(recent);
  if (recentLine) lines.push(recentLine);
  if (input.gitStatus) lines.push(input.gitStatus);

  const planLine = openStepsLine(openTasks);
  if (planLine) lines.push(planLine);

  if (turnIdx >= restateAfter) {
    const goal = goalLine(firstUserText);
    if (goal) lines.push(goal);
    const criteriaLine = bulletLine("Success criteria (all must hold before you finish)", successCriteria);
    if (criteriaLine) lines.push(criteriaLine);
    const constraintLine = bulletLine("Hard constraints (do not violate)", constraints);
    if (constraintLine) lines.push(constraintLine);
  }

  if (lines.length === 0) return null;
  return [OPEN, ...lines, CLOSE].join("\n");
}

// Max open steps to surface — enough to anchor a real plan, capped so a runaway
// task list can't bloat every prompt.
const OPEN_STEPS_CAP = 12;
const STEP_MAX_CHARS = 100;

function openStepsLine(openTasks: { id: string; description: string }[]): string | null {
  if (openTasks.length === 0) return null;
  const shown = openTasks.slice(0, OPEN_STEPS_CAP).map((t, i) => {
    const d = t.description.replace(/\s+/g, " ").trim();
    const clipped = d.length > STEP_MAX_CHARS ? d.slice(0, STEP_MAX_CHARS) + "…" : d;
    return `${i + 1}. ${clipped}`;
  });
  const more = openTasks.length > OPEN_STEPS_CAP ? ` (+${openTasks.length - OPEN_STEPS_CAP} more)` : "";
  return `Open plan steps still to finish${more}:\n  ${shown.join("\n  ")}`;
}

function bulletLine(label: string, items: string[]): string | null {
  const cleaned = items.map(s => s.trim()).filter(Boolean);
  if (cleaned.length === 0) return null;
  return `${label}: ${cleaned.join("; ")}`;
}

function recentActionsLine(recent: LedgerAction[]): string | null {
  if (recent.length === 0) return null;
  const parts = recent.map(a => {
    // Deliberately binary-ish: every failure flavor (error/blocked/declined/
    // timeout) renders ✗ — this ephemeral digest line is orientation, not a
    // place to leak envelope taxonomy. ⊘ stays reserved for cancelled.
    const mark = a.status === "ok" ? "✓" : a.status === "cancelled" ? "⊘" : "✗";
    return `${a.tool}${mark}`;
  });
  return `Recent actions (across this conversation): ${parts.join(", ")}`;
}

function goalLine(firstUserText: string): string | null {
  const text = firstUserText.trim();
  if (!text) return null;
  const oneLine = text.replace(/\s+/g, " ");
  const clipped = oneLine.length > GOAL_MAX_CHARS ? oneLine.slice(0, GOAL_MAX_CHARS) + "…" : oneLine;
  return `Original request: "${clipped}"`;
}
