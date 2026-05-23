// Middleware nudge/abort surfacing. Two distinct effects share a file because
// they're the only path by which the safety middleware stack writes back
// into op_messages / op_events from inside the turn:
//   - appendNudgeAsUserMessage: synthesize a user-role message so the next
//     adapter call (or this one, for beforeTurn) sees the nudge inline.
//   - middlewareAbortResult: build the DriveTurnResult shape returned when
//     beforeTurn aborts before any adapter/tool work happens.

import { randomUUID } from "node:crypto";
import type { Op } from "../../ops/types.js";
import type { OpMessageRow } from "../types.js";
import { appendOpMessage, readOpMessages } from "../store.js";
import { emit } from "../event-emitter.js";
import type { FiredMiddlewareResult } from "../middlewares/host.js";
import type { DriveTurnResult } from "./types.js";

/** Append a synthetic user-role op_message carrying a middleware nudge.
 *  Sits in op_messages at (turnIdx, seqInTurn=N) where N is one past any
 *  existing row in that turn. The next driveTurn(turnIdx) — or this turn,
 *  for a beforeTurn nudge — sees it via the standard buildTurnInput
 *  history read. */
export function appendNudgeAsUserMessage(opId: string, turnIdx: number, message: string): void {
  const existing = readOpMessages(opId).filter(m => m.turnIdx === turnIdx).length;
  const row: OpMessageRow = {
    messageId: `nudge-${opId}-${turnIdx}-${existing}-${randomUUID().slice(0, 6)}`,
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
    content: { text: message, kind: "nudge" },
    createdAt: new Date().toISOString(),
  };
  appendOpMessage(row);
  emit(opId, "message_appended", { turnIdx, role: row.role, messageId: row.messageId });
}

export function middlewareAbortResult(
  op: Op,
  turnIdx: number,
  fired: FiredMiddlewareResult,
): DriveTurnResult {
  if (fired.kind !== "abort") throw new Error("middlewareAbortResult requires abort verdict");
  emit(op.id, "error", {
    code: "middleware-abort",
    message: fired.message ?? `Turn aborted by ${fired.firedBy ?? "middleware"}.`,
    retryable: false,
  });
  // Reserved for future per-turn telemetry; the abort emit above already
  // surfaces the turn's stop reason.
  void turnIdx;
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
