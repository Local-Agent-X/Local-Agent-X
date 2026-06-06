/**
 * Per-turn situational-awareness digest.
 *
 * A compact, always-present block injected into the model's view at the start
 * of every interactive turn so the agent knows what it has been doing without
 * re-reading the whole conversation. Three things the replayed history does
 * NOT surface compactly:
 *
 *   - Recent actions + outcomes — which tools ran the last few turns and
 *     whether they succeeded. The raw tool_result rows are verbose and easy
 *     to lose; this is the one-line receipt.
 *   - Pace / budget — how deep into the op we are and roughly how many tokens
 *     it has burned. Lets the model self-pace instead of looping blind.
 *   - Goal restatement — on long ops the original request has scrolled far
 *     back; a one-liner keeps it anchored. Skipped early when it's still
 *     visible right above.
 *
 * The digest is EPHEMERAL: built fresh each turn from op_turns/op_messages and
 * prepended to the turn's last user message in build-input.ts. It is never
 * written to op_messages, so it does not accumulate across turns and the
 * persisted transcript / UI never sees it.
 *
 * Capability awareness is deliberately NOT here: the adapter already ships the
 * full tool surface (TurnInput.tools) to the model every turn, so a "tools you
 * have" line would be pure duplication.
 */
import type { Op } from "../../ops/types.js";
import { readOpTurns, readOpMessages } from "../store.js";
import type { OpTurnRow } from "../types.js";

// How many recent turns to summarize in the "recent actions" line.
const RECENT_TURNS = 5;
// Below this turn index the original request is still visible just above, so a
// goal restatement is noise. At/after it the request has scrolled away.
const GOAL_RESTATE_AFTER_TURN = 6;
const GOAL_MAX_CHARS = 160;

const OPEN = "[SITUATIONAL CONTEXT — system-generated, not from the user]";
const CLOSE = "[END CONTEXT]";

/**
 * Build the digest block for `op` at `turnIdx`, or null when there is nothing
 * worth saying (turn 0 — no history yet, fresh request right there). Does the
 * disk reads, then defers to the pure `composeDigest`.
 */
export function buildSituationalAwareness(op: Op, turnIdx: number): string | null {
  if (turnIdx <= 0) return null;
  const turns = readOpTurns(op.id);
  const firstUserText =
    turnIdx >= GOAL_RESTATE_AFTER_TURN ? firstUserMessageText(op.id) : "";
  return composeDigest({ turnIdx, turns, firstUserText });
}

/** Pure digest formatter — no IO, so it's unit-testable. */
export function composeDigest(input: {
  turnIdx: number;
  turns: OpTurnRow[];
  firstUserText: string;
}): string | null {
  const { turnIdx, turns, firstUserText } = input;
  if (turnIdx <= 0) return null;

  const lines: string[] = [];

  lines.push(paceLine(turnIdx, turns));

  const recent = recentActionsLine(turns);
  if (recent) lines.push(recent);

  if (turnIdx >= GOAL_RESTATE_AFTER_TURN) {
    const goal = goalLine(firstUserText);
    if (goal) lines.push(goal);
  }

  if (lines.length === 0) return null;
  return [OPEN, ...lines, CLOSE].join("\n");
}

function paceLine(turnIdx: number, turns: OpTurnRow[]): string {
  let inTok = 0;
  let outTok = 0;
  for (const t of turns) {
    const p = t.providerState?.providerPayload as
      | { usageInputTokens?: number; usageOutputTokens?: number }
      | undefined;
    if (typeof p?.usageInputTokens === "number") inTok += p.usageInputTokens;
    if (typeof p?.usageOutputTokens === "number") outTok += p.usageOutputTokens;
  }
  const total = inTok + outTok;
  const tokenPart = total > 0 ? ` · ~${Math.round(total / 1000)}k tokens used so far` : "";
  return `Turn ${turnIdx + 1} of this request${tokenPart}.`;
}

function recentActionsLine(turns: OpTurnRow[]): string | null {
  const recent = turns.slice(-RECENT_TURNS);
  const parts: string[] = [];
  for (const t of recent) {
    for (const c of t.toolCallSummary ?? []) {
      const mark = c.resultStatus === "ok" ? "✓" : c.resultStatus === "error" ? "✗" : "⊘";
      parts.push(`${c.tool}${mark}`);
    }
  }
  if (parts.length === 0) return null;
  return `Recent actions: ${parts.join(", ")}`;
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
