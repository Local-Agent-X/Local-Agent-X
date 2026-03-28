// Swarm Message Bus -- Inter-agent communication layer

import type { SwarmMessage, MessageType } from "./types.js";
import { EventBus } from "../event-bus.js";

type MessageHandler = (message: SwarmMessage) => void | Promise<void>;

export class SwarmMessageBus {
  private messages: SwarmMessage[] = [];
  private subscribers = new Map<string, Set<MessageHandler>>();
  private contextPool = new Map<string, unknown>();

  send(from: string, to: string, type: MessageType, payload: unknown): void {
    const msg: SwarmMessage = {
      from,
      to,
      type,
      payload,
      timestamp: Date.now(),
    };
    this.messages.push(msg);

    const handlers = this.subscribers.get(to);
    if (handlers) {
      for (const handler of handlers) {
        handler(msg);
      }
    }

    EventBus.emit("swarm:message", { from, to, type });
  }

  broadcast(from: string, type: MessageType, payload: unknown): void {
    const timestamp = Date.now();
    for (const [agentId] of this.subscribers) {
      if (agentId === from) continue;
      const msg: SwarmMessage = { from, to: agentId, type, payload, timestamp };
      this.messages.push(msg);

      const handlers = this.subscribers.get(agentId);
      if (handlers) {
        for (const handler of handlers) {
          handler(msg);
        }
      }
    }
    EventBus.emit("swarm:broadcast", { from, type });
  }

  subscribe(agentId: string, handler: MessageHandler): void {
    let handlers = this.subscribers.get(agentId);
    if (!handlers) {
      handlers = new Set();
      this.subscribers.set(agentId, handlers);
    }
    handlers.add(handler);
  }

  unsubscribe(agentId: string): void {
    this.subscribers.delete(agentId);
  }

  getMessages(agentId: string): SwarmMessage[] {
    return this.messages.filter((m) => m.to === agentId);
  }

  getConversation(agent1: string, agent2: string): SwarmMessage[] {
    return this.messages.filter(
      (m) =>
        (m.from === agent1 && m.to === agent2) ||
        (m.from === agent2 && m.to === agent1)
    );
  }

  publishContext(key: string, value: unknown): void {
    this.contextPool.set(key, value);
  }

  readContext(key: string): unknown {
    return this.contextPool.get(key);
  }

  listContextKeys(): string[] {
    return [...this.contextPool.keys()];
  }

  getHistory(): SwarmMessage[] {
    return [...this.messages];
  }

  clear(): void {
    this.messages = [];
    this.subscribers.clear();
    this.contextPool.clear();
  }
}
