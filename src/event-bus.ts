// ── Event Bus ── Pub/sub system for decoupling components
//
// Every topic the bus carries is declared in EventTopics with its payload, so
// an emit and its listeners agree on the shape at compile time, and a topic
// exists only while something fires it AND something hears it:
// event-bus-topics.test.ts scans src for both. An emit nobody hears is a
// feature that silently does nothing (the agency's pause/resume/cancel and
// `handler:agent-user-input` were); a listener nobody fires is dead code.

import { createLogger } from "./logger.js";
import type { AgentResultEvent, AgentSpawnEvent } from "./server/handler-events-agent-result.js";

const log = createLogger("event-bus");

export interface EventTopics {
  /** A delegated agent run started (agents/invoke.ts). */
  "handler:agent-spawn": AgentSpawnEvent;
  /** A delegated agent run finished (agents/invoke.ts). */
  "handler:agent-result": AgentResultEvent;
  /** A line of a delegated run's progress (server/handler-events.ts). */
  "handler:agent-output": { agentId: string; output: string };
  /** The user redirected a delegated run (agency/handler.ts). */
  "handler:agent-redirect": { agentId: string; newInstruction: string };
  /** A UI event from the agent's browser (browser/bridge-perception.ts). */
  "ui:browser": Record<string, unknown>;
}

export type EventName = keyof EventTopics;
/** `"ui:*"` — every topic with that prefix; the payload is whichever fired. */
export type EventPattern = `${string}:*`;

/** Every topic, for event-bus-topics.test.ts; the compiler checks it matches
 *  EventTopics in both directions. */
export const EVENT_TOPICS = [
  "handler:agent-spawn", "handler:agent-result", "handler:agent-output", "handler:agent-redirect", "ui:browser",
] as const satisfies readonly EventName[];
type MissingTopic = Exclude<EventName, (typeof EVENT_TOPICS)[number]>;
const _everyTopicListed: MissingTopic extends never ? true : never = true;
void _everyTopicListed;

type EventHandler<T = unknown> = (data: T) => void | Promise<void>;

const MAX_LISTENERS_PER_EVENT = 100;

class EventBusImpl {
  private handlers = new Map<string, Set<EventHandler>>();

  on<K extends EventName>(event: K, handler: EventHandler<EventTopics[K]>): void;
  on(event: EventPattern, handler: EventHandler): void;
  on(event: string, handler: EventHandler<never>): void {
    const existing = this.handlers.get(event);
    if (existing && existing.size >= MAX_LISTENERS_PER_EVENT) {
      throw new Error(
        `Listener limit (${MAX_LISTENERS_PER_EVENT}) reached for event "${event}". ` +
          "Possible memory leak — remove unused listeners before adding more."
      );
    }
    if (!existing) {
      this.handlers.set(event, new Set([handler as EventHandler]));
    } else {
      existing.add(handler as EventHandler);
    }
  }

  off<K extends EventName>(event: K, handler: EventHandler<EventTopics[K]>): void;
  off(event: EventPattern, handler: EventHandler): void;
  off(event: string, handler: EventHandler<never>): void {
    const set = this.handlers.get(event);
    if (!set) return;
    set.delete(handler as EventHandler);
    if (set.size === 0) this.handlers.delete(event);
  }

  once<K extends EventName>(event: K, handler: EventHandler<EventTopics[K]>): void {
    const wrapped: EventHandler<EventTopics[K]> = (data) => {
      this.off(event, wrapped);
      return handler(data);
    };
    this.on(event, wrapped);
  }

  async emit<K extends EventName>(event: K, data: EventTopics[K]): Promise<void> {
    const tasks: Promise<void>[] = [];

    // Listener isolation: a throwing/rejecting handler must never abort
    // fanout to the other listeners or propagate into the emitter — one
    // bad agent-result listener would otherwise wedge result delivery
    // for everyone else. Sync throws are caught here; async rejections
    // are absorbed by allSettled below. Failures are logged, not rethrown.
    const invoke = (handler: EventHandler): void => {
      try {
        const result = handler(data);
        if (result instanceof Promise) tasks.push(result);
      } catch (err) {
        log.error(`listener for "${event}" threw`, err);
      }
    };

    // Direct listeners
    const direct = this.handlers.get(event);
    if (direct) {
      for (const handler of [...direct]) invoke(handler);
    }

    // Wildcard listeners — match "tool:*" against "tool:start", etc.
    for (const [pattern, handlers] of this.handlers) {
      if (!pattern.endsWith(":*")) continue;
      const prefix = pattern.slice(0, -1); // "tool:"
      if (event.startsWith(prefix) && pattern !== event) {
        for (const handler of [...handlers]) invoke(handler);
      }
    }

    const settled = await Promise.allSettled(tasks);
    for (const outcome of settled) {
      if (outcome.status === "rejected") {
        log.error(`listener for "${event}" rejected`, outcome.reason);
      }
    }
  }

  listenerCount(event: EventName | EventPattern): number {
    return this.handlers.get(event)?.size ?? 0;
  }

  removeAllListeners(event?: EventName | EventPattern): void {
    if (event) {
      this.handlers.delete(event);
    } else {
      this.handlers.clear();
    }
  }
}

// Singleton
let instance: EventBusImpl | null = null;

export class EventBus {
  static getInstance(): EventBusImpl {
    if (!instance) {
      instance = new EventBusImpl();
    }
    return instance;
  }

  static on<K extends EventName>(event: K, handler: EventHandler<EventTopics[K]>): void;
  static on(event: EventPattern, handler: EventHandler): void;
  static on(event: EventName | EventPattern, handler: EventHandler<never>): void {
    EventBus.getInstance().on(event as EventPattern, handler as EventHandler);
  }

  static off<K extends EventName>(event: K, handler: EventHandler<EventTopics[K]>): void;
  static off(event: EventPattern, handler: EventHandler): void;
  static off(event: EventName | EventPattern, handler: EventHandler<never>): void {
    EventBus.getInstance().off(event as EventPattern, handler as EventHandler);
  }

  static once<K extends EventName>(event: K, handler: EventHandler<EventTopics[K]>): void {
    EventBus.getInstance().once(event, handler);
  }

  static async emit<K extends EventName>(event: K, data: EventTopics[K]): Promise<void> {
    await EventBus.getInstance().emit(event, data);
  }

  static listenerCount(event: EventName | EventPattern): number {
    return EventBus.getInstance().listenerCount(event);
  }

  static removeAllListeners(event?: EventName | EventPattern): void {
    EventBus.getInstance().removeAllListeners(event);
  }

  static reset(): void {
    instance = null;
  }
}

export type { EventHandler };
