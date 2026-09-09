// Middleware nudge/abort surfacing. Two distinct effects share a file because
// they're the only path by which the safety middleware stack writes back
// into op_messages / op_events from inside the turn:
//   - appendNudgeAsUserMessage: synthesize a user-role message so the next
//     adapter call (or this one, for beforeTurn) sees the nudge inline.
//   - middlewareAbortResult: build the DriveTurnResult shape returned when
//     beforeTurn aborts before any adapter/tool work happens.
//
// Both record a guard fire. This file counts NUDGES (all of them, middleware
// and completion-gate) and the BEFORETURN abort; the later-phase aborts and
// every suspend are counted by apply-directive.ts and suspension.ts. What the
// counter does and does not cover, in one place: guard-fire.ts.

import { randomUUID } from "node:crypto";
import type { Op } from "../../ops/types.js";
import type { OpMessageRow } from "../types.js";
import { appendOpMessage, readOpMessages, readOpTurn } from "../store.js";
import { emit, emitErrorOnce } from "../event-emitter.js";
import type { FiredMiddlewareResult } from "../middlewares/host.js";
import type { DriveTurnResult } from "./types.js";
import type { NudgeMetadata } from "../middlewares/types.js";
import { firedResultFire, recordGuardFire, type GuardFire } from "./guard-fire.js";

/**
 * The one canonical wire-format nudge for a tool call that arrived as TEXT.
 * Keeps the `<wire-format-error: …>` frame the history-rebuild sanitizer
 * (anthropic-client/parse.ts) already stamps into rebuilt history, so the model
 * meets one vocabulary for the failure whichever path caught it. Used by the
 * unresolved-tool-intent completion gate (tool-intent-gate.ts).
 */
export const WIRE_FORMAT_NUDGE_ID = "wire-format";

/** @see WIRE_FORMAT_NUDGE_ID — the id `context/rule-registry.ts` references. */
export const WIRE_FORMAT_NUDGE =
  "<wire-format-error: your previous reply contained a tool call written as text. " +
  "It was NOT executed and produced no result. Reissue it now as a real structured " +
  "tool call, not as text.>";

/** Append a synthetic user-role op_message carrying a middleware nudge.
 *  Sits in op_messages at (turnIdx, seqInTurn=N) where N is one past any
 *  existing row in that turn. The next driveTurn(turnIdx) — or this turn,
 *  for a beforeTurn nudge — sees it via the standard buildTurnInput
 *  history read. */
export function appendNudgeAsUserMessage(
  opId: string,
  turnIdx: number,
  message: string,
  source: GuardFire,
  metadata?: NudgeMetadata,
  stableMessageId?: string,
): boolean {
  const messages = readOpMessages(opId);
  if (stableMessageId && messages.some(row => row.messageId === stableMessageId)) return false;
  const existing = messages.filter(m => m.turnIdx === turnIdx).length;
  const row: OpMessageRow = {
    messageId: stableMessageId ?? `nudge-${opId}-${turnIdx}-${existing}-${randomUUID().slice(0, 6)}`,
    opId,
    turnIdx,
    seqInTurn: existing,
    // role MUST stay "user" — providers need this as input so the model
    // treats the nudge as a user instruction on the next turn. The UI
    // distinguishes nudges from real user messages via `content.kind`
    // below, so it can render them as small italic system notes (or hide
    // them entirely) without ever surfacing the synthetic message as if
    // the user typed it. Adapters' canonicalToTransport only emits
    // `content.text` so the `kind` marker stays on our side of the wire.
    role: "user",
    content: { text: message, kind: "nudge", ...metadata },
    createdAt: new Date().toISOString(),
  };
  appendOpMessage(row);
  emit(opId, "message_appended", { turnIdx, role: row.role, messageId: row.messageId });
  // Count the fire on the ONE path that actually writes the nudge: every early
  // return above is a dedup no-op, and a replayed nudge is not a new fire.
  // Before this event the only record a guard had fired was its own prose in
  // op_messages, so rewording a nudge erased its history. Which guards this
  // does and does not count: guard-fire.ts.
  recordGuardFire(opId, turnIdx, source);
  return true;
}

/** Materialize a pivot intent only after its source turn is durable. The
 * deterministic message id makes retries and restart recovery exactly-once. */
export function recoverCommittedStrategyPivot(opId: string, sourceTurnIdx: number): boolean {
  if (sourceTurnIdx < 0) return false;
  const pivot = readOpTurn(opId, sourceTurnIdx)?.nextTurnPivot;
  if (!pivot) return false;
  // The pivot MECHANISM is shared: loop-detection, mid-turn-stale and
  // strategy-pivot all fire nudges carrying metadata.strategyPivot. Naming this
  // fire "strategy-pivot" would file three guards under one name and leave the
  // other two reading 0, so turn-loop.ts persists the originating middleware on
  // the turn row and this replays it. `unknown` covers only rows committed
  // before that field existed — there is genuinely no name to recover there.
  return appendNudgeAsUserMessage(
    opId,
    sourceTurnIdx + 1,
    pivot.message,
    { name: pivot.firedBy ?? "unknown", reason: "strategy-pivot", outcome: "nudge" },
    pivot.metadata,
    `strategy-pivot-${opId}-${sourceTurnIdx}`,
  );
}

export function middlewareAbortResult(
  op: Op,
  turnIdx: number,
  fired: FiredMiddlewareResult,
): DriveTurnResult {
  if (fired.kind !== "abort") throw new Error("middlewareAbortResult requires abort verdict");
  // An abort is a fire too — the loudest one, since it ends the turn. The error
  // event says the turn stopped; the fire says WHICH guard stopped it. Counted
  // only when the bubble is really emitted: emitErrorOnce collapses a repeat of
  // the same abort, and an unconditional emit beside it would also flush
  // chat-runner/event-pump.ts's held `aborted` acknowledgement, showing the user
  // "aborted" AND the cause instead of the cause alone.
  //
  // This is the beforeTurn abort only. Every later-phase abort (loop-detection,
  // repeat-output, repeat-failure, thrash-guard) bubbles as a sticky directive
  // and is counted in apply-directive.ts.
  const bubbled = emitErrorOnce(op.id, {
    code: "middleware-abort",
    message: fired.message ?? `Turn aborted by ${fired.firedBy ?? "middleware"}.`,
    retryable: false,
  });
  if (bubbled) recordGuardFire(op.id, turnIdx, firedResultFire(fired));
  return {
    terminalReason: "error",
    toolCount: 0,
    messageCount: 0,
    cancelled: false,
    middlewareDirective: {
      kind: "abort",
      reason: fired.reason ?? "unknown",
      firedBy: fired.firedBy ?? "unknown",
      message: fired.message,
    },
  };
}
