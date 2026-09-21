// What the channel stamps onto an outgoing frame.
//
// Split from ./manager.ts (2026-09-21, 400-LOC gate). Both stamps answer the
// same question from the client's side — "which turn is this frame from, and
// where in that turn does it sit" — and neither needs anything else the
// manager holds, so they live together here and the manager keeps the
// accumulate-and-fan-out loop.

import type { ServerEvent } from "../types.js";
import type { ActiveChat } from "./state.js";

// Attach the owning op to one live envelope, without mutating the caller's
// event. Only the variants that DECLARE `opId` (types/server-events.ts) are
// stamped — the rest have no such field on the wire contract. An event that
// already names its op keeps it: the emitter knew better than the channel.
export function stampOpId(event: ServerEvent, opId: string | undefined): ServerEvent {
  if (!opId) return event;
  switch (event.type) {
    case "stream": case "reasoning": case "tool_start": case "tool_progress":
    case "tool_end": case "tool_chip": case "done": case "stopped":
    case "error": case "op_heartbeat":
      return event.opId ? event : { ...event, opId };
    default:
      return event;
  }
}

// Stamp a text frame's position in the turn's ordered timeline. The two text
// lanes share one counter because the client applies them to one timeline, and
// only they are stamped — see ActiveChat.textSeq for why the other classes
// already have an identity and these two did not.
export function stampTextSeq(event: ServerEvent, chat: ActiveChat): ServerEvent {
  if (event.type !== "stream" && event.type !== "reasoning") return event;
  return { ...event, seq: ++chat.textSeq };
}
