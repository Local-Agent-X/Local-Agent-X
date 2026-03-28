// ── Event Bus ── Pub/sub system for decoupling components

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
    const tasks: (void | Promise<void>)[] = [];

    // Direct listeners
    const direct = this.handlers.get(event);
    if (direct) {
      for (const handler of [...direct]) {
        tasks.push(handler(data));
      }
    }

    // Wildcard listeners — match "tool:*" against "tool:start", etc.
    for (const [pattern, handlers] of this.handlers) {
      if (!pattern.endsWith(":*")) continue;
      const prefix = pattern.slice(0, -1); // "tool:"
      if (event.startsWith(prefix) && pattern !== event) {
        for (const handler of [...handlers]) {
          tasks.push(handler(data));
        }
      }
    }

    await Promise.all(tasks);
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
  private static instance: EventBusImpl;

  private static getInstance(): EventBusImpl {
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
