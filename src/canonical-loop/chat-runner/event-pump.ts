// Event pump for the chat-runner async generator. Subscribes to the op's
// stream + event bus, buffers ServerEvents in a queue, and exposes a
// pull() that suspends until either events arrive or the op reaches a
// terminal state. Lets the orchestrator drain with a clean
// `while ({events, terminal} = await pump.pull())` loop instead of
// hand-rolling the queue/waiter/terminal dance inline.

import type { ServerEvent } from "../../types.js";
import type { CanonicalEvent, StateChangedBody } from "../types.js";
import { subscribeOpStream, subscribeOpEvents } from "../control-api.js";
import { isTerminalState, type TerminalState } from "../terminal-states.js";

export interface PumpedEvents {
  events: ServerEvent[];
  terminal: TerminalState | null;
}

export interface EventPump {
  /** Push a ServerEvent into the queue (used by the orchestrator for
   *  events it synthesizes itself, like chat_op_started). */
  push(ev: ServerEvent): void;
  /** Suspend until queue has events OR op reaches terminal. Returns
   *  drained queue + current terminal state. */
  pull(): Promise<PumpedEvents>;
  dispose(): void;
}

/** User-facing wording for a checkpoint that STOPPED. `stopReason` comes from
 *  canonical-loop/checkpoint-stop.ts; the turn-count phrasing is the fallback
 *  for an op that stopped without one (e.g. a relayed pre-upgrade event). */
function checkpointStopPhrase(
  stopReason: string | null,
  stopDetail: string | null,
  maxTurns: number | null,
): { line: string; short: string } {
  switch (stopReason) {
    case "dry-checkpoints":
      return {
        line: "I stopped here: the last stretch of work turned up nothing new, so continuing would just repeat it.",
        short: "Stopped — no new information in the last stretch.",
      };
    case "spend-ceiling":
      return {
        line: `I stopped here to stay inside your spend budget${stopDetail ? ` (${stopDetail})` : ""}. You can raise it in Settings.`,
        short: "Stopped — spend budget reached.",
      };
    default:
      return maxTurns
        ? {
          line: `I reached the ${maxTurns}-iteration checkpoint.`,
          short: `Checkpoint reached after ${maxTurns} iterations.`,
        }
        : { line: "I reached the iteration checkpoint.", short: "Iteration checkpoint reached." };
  }
}

/** "2 hours", "45 minutes", "1 hour 30 minutes", "12 seconds" — for the
 *  wall-clock notice. */
function humanDuration(ms: number): string {
  if (ms < 60_000) {
    const s = Math.max(1, Math.round(ms / 1000));
    return `${s} second${s === 1 ? "" : "s"}`;
  }
  const totalMin = Math.round(ms / 60_000);
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  const hours = h > 0 ? `${h} hour${h === 1 ? "" : "s"}` : "";
  const mins = m > 0 ? `${m} minute${m === 1 ? "" : "s"}` : "";
  return [hours, mins].filter(Boolean).join(" ");
}

export function createEventPump(opId: string): EventPump {
  const eventQueue: ServerEvent[] = [];
  let waiter: (() => void) | null = null;
  let terminal: TerminalState | null = null;
  let emittedIterationCheckpoint = false;
  // An adapter's `aborted` error report, held back for exactly one event. It
  // is an acknowledgement, not news: whatever aborted the adapter (deadline,
  // cancel, lease loss) explains itself on the very next event. The deadline
  // path replaces it with the human notice; every other event flushes it
  // unchanged and in order, so nothing else's behaviour moves.
  let heldAbort: ServerEvent | null = null;

  const wake = () => {
    if (waiter) {
      const w = waiter;
      waiter = null;
      w();
    }
  };

  const offStream = subscribeOpStream(opId, (chunk) => {
    const c = chunk as {
      delta?: string; replace?: boolean; text?: string; reasoning?: boolean;
      stopped?: boolean; reason?: string; debug?: string; firedBy?: string;
    } | null;
    // Adapter-initiated text replacement (e.g. tool-call-from-text
    // extractor stripping JSON that was already streamed). Forward to
    // the client as a stream event with replace:true so it swaps the
    // bubble's text rather than appending.
    if (c?.replace === true) {
      eventQueue.push({ type: "stream", replace: true, text: c.text ?? "" });
      wake();
      return;
    }
    // Adapter-level early-stop notice (degenerate-output stream guard).
    // The adapter contract has no "stopped" report kind, so the notice rides
    // the op-stream bus as a marker chunk; map it to the same `stopped`
    // ServerEvent shape the iteration-budget path emits below. Consumers
    // that only read delta/replace chunks ignore the marker by invariant.
    if (c?.stopped === true) {
      eventQueue.push({
        type: "stopped",
        reason: typeof c.reason === "string" && c.reason.length > 0 ? c.reason : "Stream stopped early.",
        ...(typeof c.debug === "string" ? { debug: c.debug } : {}),
        ...(typeof c.firedBy === "string" ? { firedBy: c.firedBy } : {}),
      });
      wake();
      return;
    }
    // Live chain-of-thought — a separate rendering lane from answer text.
    if (c?.reasoning === true) {
      const rd = c.delta;
      if (typeof rd === "string" && rd.length > 0) {
        eventQueue.push({ type: "reasoning", delta: rd });
        wake();
      }
      return;
    }
    const delta = c?.delta;
    if (typeof delta !== "string" || delta.length === 0) return;
    eventQueue.push({ type: "stream", delta });
    wake();
  });

  const offEvents = subscribeOpEvents(opId, (event: CanonicalEvent) => {
    const eventCode = event.type === "error"
      ? ((event.body ?? {}) as Record<string, unknown>).code
      : undefined;
    if (heldAbort && eventCode !== "deadline_exceeded") {
      eventQueue.push(heldAbort);
      heldAbort = null;
      wake();
    }
    if (event.type === "state_changed") {
      const body = event.body as StateChangedBody | undefined;
      const to = body?.to;
      if (isTerminalState(to)) {
        terminal = to;
        wake();
      }
      return;
    }
    if (event.type === "error") {
      const b = (event.body ?? {}) as Record<string, unknown>;
      const code = (b.code as string | undefined) ?? "error";
      const message = (b.message as string | undefined) ?? "(no message)";
      if (code === "max_turns_exceeded") {
        const maxTurns = message.match(/maxTurns=(\d+)/)?.[1];
        const checkpoint =
          maxTurns
            ? `\n\nI reached the ${maxTurns}-iteration checkpoint, so I stopped here instead of running forever. Say "continue" and I'll pick up from the work already done.`
            : `\n\nI reached the iteration checkpoint, so I stopped here instead of running forever. Say "continue" and I'll pick up from the work already done.`;
        if (!emittedIterationCheckpoint) {
          eventQueue.push({ type: "stream", delta: checkpoint });
          emittedIterationCheckpoint = true;
        }
        eventQueue.push({
          type: "stopped",
          reason: maxTurns
            ? `Paused at ${maxTurns} iterations. Say "continue" to keep going.`
            : `Paused at the iteration checkpoint. Say "continue" to keep going.`,
          debug: `${code}: ${message.slice(0, 240)}`,
          firedBy: "iteration-budget",
        });
        wake();
        return;
      }
      if (code === "aborted") {
        heldAbort = { type: "error", message: `${code}: ${message.slice(0, 240)}` };
        return;
      }
      if (code === "deadline_exceeded") {
        // The interactive wall-clock backstop. With no turn wall this is what
        // a user who walked away comes back to, so it must read like the
        // checkpoint notice — how long it ran, that the work is saved, how to
        // continue — not a raw maxWallTimeMs string. The op still ends
        // `failed` (learnedOutcome aborted); only the wording changes here.
        // The adapter's own "aborted" acknowledgement (held above) is what
        // the deadline caused, not a second failure — drop it.
        heldAbort = null;
        const elapsedMs = typeof b.elapsedMs === "number" ? b.elapsedMs : null;
        const ranFor = elapsedMs !== null ? ` after ${humanDuration(elapsedMs)}` : "";
        if (!emittedIterationCheckpoint) {
          eventQueue.push({
            type: "stream",
            delta: `\n\nI stopped here${ranFor} — that's the time limit for a single request. The work so far is saved; say "continue" and I'll pick it up from there.`,
          });
          emittedIterationCheckpoint = true;
        }
        eventQueue.push({
          type: "stopped",
          reason: `Stopped${ranFor} — time limit for one request reached. Say "continue" to keep going.`,
          debug: `${code}: ${message.slice(0, 240)}`,
          firedBy: "wall-clock",
        });
        wake();
        return;
      }
      eventQueue.push({ type: "error", message: `${code}: ${message.slice(0, 240)}` });
      wake();
      return;
    }
    if (event.type === "iteration_checkpoint") {
      const b = (event.body ?? {}) as Record<string, unknown>;
      const maxTurns = typeof b.maxTurns === "number" ? b.maxTurns : null;
      const completedTurns = typeof b.completedTurns === "number" ? b.completedTurns : null;
      const stopReason = typeof b.stopReason === "string" ? b.stopReason : null;
      const stopDetail = typeof b.stopDetail === "string" ? b.stopDetail : null;
      if (b.continuing === true) {
        // A continuing checkpoint is a CADENCE marker, not a stop. This branch
        // used to `return` and emit nothing at all — which, now that the
        // interactive lane also continues, would leave a user who walked away
        // staring at a transcript that says nothing for hours. Surface the same
        // progress line the background dock shows (session-bridge-observer.ts).
        // Deliberately NOT gated on `emittedIterationCheckpoint`: the cadence
        // repeats, and each pass is fresh news.
        const turns = completedTurns ?? maxTurns;
        eventQueue.push({
          type: "stream",
          delta: `\n\n_Checkpoint saved${turns !== null ? ` after ${turns} turns` : ""} — still working; continuing automatically._\n\n`,
        });
        wake();
        return;
      }
      // Stopped. Name the real reason when the worker supplied one; the bare
      // count is only meaningful when nothing better is known.
      const because = checkpointStopPhrase(stopReason, stopDetail, maxTurns);
      if (!emittedIterationCheckpoint) {
        eventQueue.push({
          type: "stream",
          delta: `\n\n${because.line} The work so far is saved; say "continue" and I'll pick it up from there.`,
        });
        emittedIterationCheckpoint = true;
      }
      eventQueue.push({
        type: "stopped",
        reason: `${because.short} Say "continue" to keep going.`,
        ...(stopDetail ? { debug: stopDetail.slice(0, 240) } : {}),
        firedBy: "iteration-budget",
      });
      wake();
      return;
    }
    if (event.type === "turn_committed") {
      // No user-visible event today; reserved hook for future "round N" UI.
      return;
    }
  });

  return {
    push(ev) { eventQueue.push(ev); wake(); },
    async pull() {
      while (eventQueue.length === 0 && terminal === null) {
        await new Promise<void>(r => { waiter = r; });
      }
      const events = eventQueue.splice(0, eventQueue.length);
      return { events, terminal };
    },
    dispose() { offStream(); offEvents(); },
  };
}
