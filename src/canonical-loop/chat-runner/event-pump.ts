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

export function createEventPump(opId: string): EventPump {
  const eventQueue: ServerEvent[] = [];
  let waiter: (() => void) | null = null;
  let terminal: TerminalState | null = null;
  let emittedIterationCheckpoint = false;

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
      eventQueue.push({ type: "error", message: `${code}: ${message.slice(0, 240)}` });
      wake();
      return;
    }
    if (event.type === "iteration_checkpoint") {
      const b = (event.body ?? {}) as Record<string, unknown>;
      const maxTurns = typeof b.maxTurns === "number" ? b.maxTurns : null;
      const continuing = b.continuing === true;
      if (continuing) return;
      const checkpoint = maxTurns
        ? `\n\nI reached the ${maxTurns}-iteration checkpoint. The work so far is saved; say "continue" and I'll pick it up from there.`
        : `\n\nI reached the iteration checkpoint. The work so far is saved; say "continue" and I'll pick it up from there.`;
      if (!emittedIterationCheckpoint) {
        eventQueue.push({ type: "stream", delta: checkpoint });
        emittedIterationCheckpoint = true;
      }
      eventQueue.push({
        type: "stopped",
        reason: maxTurns
          ? `Checkpoint reached after ${maxTurns} iterations. Say "continue" to keep going.`
          : `Iteration checkpoint reached. Say "continue" to keep going.`,
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
