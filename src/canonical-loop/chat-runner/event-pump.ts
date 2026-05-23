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

  const wake = () => {
    if (waiter) {
      const w = waiter;
      waiter = null;
      w();
    }
  };

  const offStream = subscribeOpStream(opId, (chunk) => {
    const c = chunk as { delta?: string; replace?: boolean; text?: string } | null;
    // Adapter-initiated text replacement (e.g. tool-call-from-text
    // extractor stripping JSON that was already streamed). Forward to
    // the client as a stream event with replace:true so it swaps the
    // bubble's text rather than appending.
    if (c?.replace === true) {
      eventQueue.push({ type: "stream", replace: true, text: c.text ?? "" });
      wake();
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
      eventQueue.push({ type: "error", message: `${code}: ${message.slice(0, 240)}` });
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
