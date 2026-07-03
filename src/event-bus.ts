// ── Event Bus ── Pub/sub system for decoupling components

import { createLogger } from "./logger.js";

const log = createLogger("event-bus");

type EventName =
  | "tool:start"
  | "tool:end"
  | "chat:message"
  | "chat:response"
  | "session:create"
  | "session:delete"
  | "error"
  | "voice:start"
  | "voice:end"
  | "mission:start"
  | "mission:step"
  | "mission:complete"
  | `${string}:${string}`;

type EventHandler = (data: unknown) => void | Promise<void>;

const MAX_LISTENERS_PER_EVENT = 100;

class EventBusImpl {
  private handlers = new Map<string, Set<EventHandler>>();
  private onceHandlers = new WeakSet<EventHandler>();

  on(event: EventName, handler: EventHandler): void {
    const existing = this.handlers.get(event);
    if (existing && existing.size >= MAX_LISTENERS_PER_EVENT) {
      throw new Error(
        `Listener limit (${MAX_LISTENERS_PER_EVENT}) reached for event "${event}". ` +
          "Possible memory leak — remove unused listeners before adding more."
      );
    }
    if (!existing) {
      this.handlers.set(event, new Set([handler]));
    } else {
      existing.add(handler);
    }
  }

  off(event: EventName, handler: EventHandler): void {
    const set = this.handlers.get(event);
    if (!set) return;
    set.delete(handler);
    if (set.size === 0) this.handlers.delete(event);
  }

  once(event: EventName, handler: EventHandler): void {
    const wrapped: EventHandler = (data) => {
      this.off(event, wrapped);
      return handler(data);
    };
    this.onceHandlers.add(wrapped);
    this.on(event, wrapped);
  }

  async emit(event: EventName, data?: unknown): Promise<void> {
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

  listenerCount(event: EventName): number {
    return this.handlers.get(event)?.size ?? 0;
  }

  removeAllListeners(event?: EventName): void {
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

  static on(event: EventName, handler: EventHandler): void {
    EventBus.getInstance().on(event, handler);
  }

  static off(event: EventName, handler: EventHandler): void {
    EventBus.getInstance().off(event, handler);
  }

  static once(event: EventName, handler: EventHandler): void {
    EventBus.getInstance().once(event, handler);
  }

  static async emit(event: EventName, data?: unknown): Promise<void> {
    await EventBus.getInstance().emit(event, data);
  }

  static listenerCount(event: EventName): number {
    return EventBus.getInstance().listenerCount(event);
  }

  static removeAllListeners(event?: EventName): void {
    EventBus.getInstance().removeAllListeners(event);
  }

  static reset(): void {
    instance = null;
  }
}

export type { EventName, EventHandler };
