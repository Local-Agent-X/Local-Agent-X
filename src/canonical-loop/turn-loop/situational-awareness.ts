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
 *   - Pace / budget — how deep into the current request we are and roughly how
 *     many tokens it has burned. Lets the model self-pace instead of looping
 *     blind. Stays per-request (per-op).
 *   - Goal restatement — on long requests the original ask has scrolled far
 *     back; a one-liner keeps it anchored. Skipped early when it's still
 *     visible right above.
 *
 * The digest is EPHEMERAL: built fresh each turn and prepended to the turn's
 * last user message in build-input.ts. It is never written to op_messages, so
 * it does not accumulate across turns and the persisted transcript / UI never
 * sees it.
 *
 * Capability awareness is deliberately NOT here: the adapter already ships the
 * full tool surface (TurnInput.tools) to the model every turn, so a "tools you
 * have" line would be pure duplication.
 */
import type { Op } from "../../ops/types.js";
import { readOpTurns, readOpMessages } from "../store.js";
import type { OpTurnRow } from "../types.js";
import { getSessionForOp } from "../../ops/session-bridge.js";
import { recentActions, type LedgerAction } from "../../ops/action-ledger.js";
import { resolveOpModel } from "../op-model.js";
import { classifyModel, type ModelTier } from "../../model-tiers.js";
import { createLogger } from "../../logger.js";

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
export function buildSituationalAwareness(op: Op, turnIdx: number): string | null {
  const sessionId = getSessionForOp(op.id) ?? "";
  const recent = sessionId ? recentActions(sessionId, RECENT_ACTIONS_CAP) : [];
  const totalTokens = sumTokens(readOpTurns(op.id));
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
  const digest = composeDigest({
    turnIdx, totalTokens, recent, firstUserText, successCriteria, constraints, restateAfter,
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
  totalTokens: number;
  recent: LedgerAction[];
  firstUserText: string;
  successCriteria?: string[];
  constraints?: string[];
  /** Turn at/after which goal + criteria re-grounding renders. Defaults to the
   *  strong-tier cadence so existing (tier-unaware) callers are unchanged. */
  restateAfter?: number;
}): string | null {
  const { turnIdx, totalTokens, recent, firstUserText } = input;
  const successCriteria = input.successCriteria ?? [];
  const constraints = input.constraints ?? [];
  const restateAfter = input.restateAfter ?? GOAL_RESTATE_AFTER_TURN_DEFAULT;
  const lines: string[] = [];

  // Pace only earns its line once we're past the first model turn of the
  // request — "Turn 1" is noise.
  if (turnIdx >= 1) lines.push(paceLine(turnIdx, totalTokens));

  const recentLine = recentActionsLine(recent);
  if (recentLine) lines.push(recentLine);

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

function bulletLine(label: string, items: string[]): string | null {
  const cleaned = items.map(s => s.trim()).filter(Boolean);
  if (cleaned.length === 0) return null;
  return `${label}: ${cleaned.join("; ")}`;
}

function sumTokens(turns: OpTurnRow[]): number {
  let total = 0;
  for (const t of turns) {
    const p = t.providerState?.providerPayload as
      | { usageInputTokens?: number; usageOutputTokens?: number }
      | undefined;
    if (typeof p?.usageInputTokens === "number") total += p.usageInputTokens;
    if (typeof p?.usageOutputTokens === "number") total += p.usageOutputTokens;
  }
  return total;
}

function paceLine(turnIdx: number, totalTokens: number): string {
  const tokenPart = totalTokens > 0 ? ` · ~${Math.round(totalTokens / 1000)}k tokens used so far` : "";
  return `Turn ${turnIdx + 1} of this request${tokenPart}.`;
}

function recentActionsLine(recent: LedgerAction[]): string | null {
  if (recent.length === 0) return null;
  const parts = recent.map(a => {
    const mark = a.status === "ok" ? "✓" : a.status === "error" ? "✗" : "⊘";
    return `${a.tool}${mark}`;
  });
  return `Recent actions (across this conversation): ${parts.join(", ")}`;
}

function firstUserMessageText(opId: string): string {
  const msgs = readOpMessages(opId);
  const firstUser = msgs.find(m => m.role === "user");
  return firstUser ? extractText(firstUser.content) : "";
}

function goalLine(firstUserText: string): string | null {
  const text = firstUserText.trim();
  if (!text) return null;
  const oneLine = text.replace(/\s+/g, " ");
  const clipped = oneLine.length > GOAL_MAX_CHARS ? oneLine.slice(0, GOAL_MAX_CHARS) + "…" : oneLine;
  return `Original request: "${clipped}"`;
}

function extractText(c: unknown): string {
  if (typeof c === "string") return c;
  if (c && typeof c === "object" && typeof (c as { text?: unknown }).text === "string") {
    return (c as { text: string }).text;
  }
  return "";
}
