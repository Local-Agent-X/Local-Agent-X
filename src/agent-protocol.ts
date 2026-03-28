import { randomUUID } from "node:crypto";

export type MessageType = "query" | "command" | "observe" | "notify" | "stream";

export type Priority = "critical" | "high" | "normal" | "low";

export interface AgentMessage {
  id: string;
  type: MessageType;
  payload: Record<string, unknown>;
  timestamp: number;
  priority: Priority;
  sequence?: number;
  correlationId?: string;
}

export interface AgentResponse {
  id: string;
  correlationId: string;
  status: "ok" | "error" | "partial";
  payload: Record<string, unknown>;
  timestamp: number;
  sequence?: number;
}

const VALID_TYPES = new Set<MessageType>([
  "query",
  "command",
  "observe",
  "notify",
  "stream",
]);

const VALID_PRIORITIES = new Set<Priority>([
  "critical",
  "high",
  "normal",
  "low",
]);

export class AgentProtocol {
  private sequenceCounter = 0;

  createMessage(
    type: MessageType,
    payload: Record<string, unknown>,
    priority: Priority = "normal",
    correlationId?: string
  ): AgentMessage {
    return {
      id: randomUUID(),
      type,
      payload,
      timestamp: Date.now(),
      priority,
      sequence: this.nextSequence(),
      correlationId,
    };
  }

  createResponse(
    message: AgentMessage,
    status: AgentResponse["status"],
    payload: Record<string, unknown>
  ): AgentResponse {
    return {
      id: randomUUID(),
      correlationId: message.id,
      status,
      payload,
      timestamp: Date.now(),
      sequence: this.nextSequence(),
    };
  }

  serialize(msg: AgentMessage | AgentResponse): Buffer {
    const json = JSON.stringify(msg);
    return Buffer.from(json, "utf-8");
  }

  deserializeMessage(data: Buffer | string): AgentMessage {
    const raw = typeof data === "string" ? data : data.toString("utf-8");
    const parsed = JSON.parse(raw) as AgentMessage;
    this.validateMessage(parsed);
    return parsed;
  }

  deserializeResponse(data: Buffer | string): AgentResponse {
    const raw = typeof data === "string" ? data : data.toString("utf-8");
    const parsed = JSON.parse(raw) as AgentResponse;
    this.validateResponse(parsed);
    return parsed;
  }

  validateMessage(msg: AgentMessage): void {
    if (!msg.id || typeof msg.id !== "string") {
      throw new Error("Message must have a string id");
    }
    if (!VALID_TYPES.has(msg.type)) {
      throw new Error(`Invalid message type: ${msg.type}`);
    }
    if (typeof msg.payload !== "object" || msg.payload === null) {
      throw new Error("Message payload must be an object");
    }
    if (typeof msg.timestamp !== "number") {
      throw new Error("Message must have a numeric timestamp");
    }
    if (!VALID_PRIORITIES.has(msg.priority)) {
      throw new Error(`Invalid priority: ${msg.priority}`);
    }
  }

  validateResponse(res: AgentResponse): void {
    if (!res.id || typeof res.id !== "string") {
      throw new Error("Response must have a string id");
    }
    if (!res.correlationId || typeof res.correlationId !== "string") {
      throw new Error("Response must have a correlationId");
    }
    if (!["ok", "error", "partial"].includes(res.status)) {
      throw new Error(`Invalid response status: ${res.status}`);
    }
    if (typeof res.payload !== "object" || res.payload === null) {
      throw new Error("Response payload must be an object");
    }
    if (typeof res.timestamp !== "number") {
      throw new Error("Response must have a numeric timestamp");
    }
  }

  compareSequence(a: { sequence?: number }, b: { sequence?: number }): number {
    return (a.sequence ?? 0) - (b.sequence ?? 0);
  }

  sortBySequence<T extends { sequence?: number }>(items: T[]): T[] {
    return [...items].sort(this.compareSequence);
  }

  sortByPriority(messages: AgentMessage[]): AgentMessage[] {
    const order: Record<Priority, number> = {
      critical: 0,
      high: 1,
      normal: 2,
      low: 3,
    };
    return [...messages].sort(
      (a, b) => order[a.priority] - order[b.priority]
    );
  }

  private nextSequence(): number {
    return ++this.sequenceCounter;
  }
}
