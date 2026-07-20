import type { ChatCompletionMessageParam } from "openai/resources/chat/completions.js";
import type { ControlTransport } from "../screen-stream/peer.js";
import type { ServerEvent } from "../types.js";
import {
  sessionEventHighWater,
  sessionEventJournalSince,
  subscribeSessionEvents,
  type SessionEventJournalEntry,
} from "../chat-ws/session-event-observers.js";
import { activeChats } from "../chat-ws/state.js";
import { readRecentSessionMessages } from "../ops/session-bridge.js";
import { listOps } from "../ops/op-store.js";
import { readCheckpoint } from "../ops/checkpoint.js";
import type { Op, OpCheckpoint } from "../ops/types.js";
import { extractFinalAssistantText, readOpTurns, type OpTurnRow } from "../canonical-loop/index.js";
import { redactString } from "../ops/redactor.js";
import type { ChatChannel } from "./chat-bridge.js";

const MAX_REPLAY_FRAMES = 128;
const MAX_MESSAGES = 40;
const MAX_OPERATIONS = 20;
const MAX_TEXT_CHARS = 4_000;

export type PhoneProjectionItem =
  | { kind: "conversation"; role: "user" | "assistant"; text: string }
  | { kind: "output"; text: string; replace: boolean }
  | { kind: "operation"; opId: string; status: string; task?: string; progress?: string }
  | { kind: "notification"; opId: string; status: "completed" | "failed" | "cancelled"; summary: string }
  | { kind: "status"; state: "started" | "done" | "stopped" | "error"; detail?: string };

export type PhoneProjectionFrame =
  | { type: "phone_projection_snapshot"; version: 1; sessionId: string; seq: number; items: PhoneProjectionItem[] }
  | { type: "phone_projection_event"; version: 1; sessionId: string; seq: number; item: PhoneProjectionItem }
  | { type: "phone_projection_error"; version: 1; code: "unauthorized" | "invalid_request" | "replay_expired" | "snapshot_unavailable" };

interface SubscribeRequest {
  type: "phone_projection_subscribe";
  deviceId: string;
  sessionId: string;
  afterSeq?: number;
}

export interface PhoneProjectionSource {
  highWater?(sessionId: string): number;
  snapshot(sessionId: string, sinceVersion?: number): PhoneProjectionItem[] | {
    items: PhoneProjectionItem[];
    coveredVersions: number[];
  };
  subscribe(sessionId: string, listener: (item: PhoneProjectionItem, version?: number) => void): () => void;
}

export interface PhoneProjectionBridgeDeps {
  pairedPhoneId: string;
  source?: PhoneProjectionSource;
}

export class PhoneProjectionBridge implements ChatChannel {
  private transport: ControlTransport | null = null;
  private unsubscribe: (() => void) | null = null;
  private sessionId = "";
  /** First authenticated subscription binds this paired transport for its lifetime. */
  private boundSessionId = "";
  private seq = 0;
  private readonly replay: Array<Extract<PhoneProjectionFrame, { type: "phone_projection_event" }>> = [];
  private closed = false;
  private readonly source: PhoneProjectionSource;

  constructor(private readonly deps: PhoneProjectionBridgeDeps) {
    this.source = deps.source ?? canonicalPhoneProjectionSource();
  }

  attach(transport: ControlTransport): void {
    if (this.closed) return;
    this.detach();
    this.transport = transport;
    transport.onMessage(text => {
      if (this.transport === transport) this.handleInbound(text);
    });
    transport.onClose(() => {
      if (this.transport === transport) this.detach();
    });
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.detach();
    this.replay.length = 0;
  }

  private detach(): void {
    this.unsubscribe?.();
    this.unsubscribe = null;
    this.transport = null;
    this.sessionId = "";
  }

  private handleInbound(text: string): void {
    const request = parseSubscribeRequest(text);
    if (!request) return this.sendError("invalid_request");
    if (request.deviceId !== this.deps.pairedPhoneId) return this.sendError("unauthorized");
    if (this.boundSessionId && request.sessionId !== this.boundSessionId) return this.sendError("unauthorized");
    this.boundSessionId ||= request.sessionId;

    this.beginSubscription(request);
  }

  private beginSubscription(request: SubscribeRequest): void {
    this.unsubscribe?.();
    this.sessionId = request.sessionId;
    const journalStart = this.source.highWater?.(request.sessionId);
    const pending: Array<{ item: PhoneProjectionItem; version?: number }> = [];
    let baseDelivered = false;
    this.unsubscribe = this.source.subscribe(request.sessionId, (item, version) => {
      if (baseDelivered) this.sendItem(request.sessionId, item);
      else pending.push({ item, version });
    });

    const replay = request.afterSeq === undefined ? "snapshot" : this.replayFrom(request.afterSeq);
    if (replay === "expired") this.sendError("replay_expired");
    let coveredVersions: Set<number> | null = null;
    try {
      coveredVersions = replay !== "replayed"
        ? this.sendSnapshot(request.sessionId, journalStart)
        : null;
    } catch {
      const unsubscribe = this.unsubscribe;
      this.unsubscribe = null;
      pending.length = 0;
      this.sessionId = "";
      this.boundSessionId = "";
      this.replay.length = 0;
      this.seq = 0;
      try { unsubscribe?.(); } catch {}
      this.sendError("snapshot_unavailable");
      return;
    }
    baseDelivered = true;
    for (const update of pending) {
      if (update.version !== undefined && coveredVersions?.has(update.version)) continue;
      this.sendItem(request.sessionId, update.item);
    }
  }

  private replayFrom(afterSeq: number): "replayed" | "snapshot" | "expired" {
    if (this.replay.length === 0) return afterSeq === 0 ? "snapshot" : "expired";
    const firstSeq = this.replay[0].seq;
    if (afterSeq < firstSeq - 1 || afterSeq > this.seq) return "expired";
    for (const frame of this.replay) {
      if (frame.sessionId === this.sessionId && frame.seq > afterSeq) this.send(frame);
    }
    return "replayed";
  }

  private sendSnapshot(sessionId: string, sinceVersion?: number): Set<number> {
    const result = this.source.snapshot(sessionId, sinceVersion);
    const items = (Array.isArray(result) ? result : result.items)
      .slice(-(MAX_MESSAGES + MAX_OPERATIONS)).map(redactItem);
    this.send({ type: "phone_projection_snapshot", version: 1, sessionId, seq: this.seq, items });
    return new Set(Array.isArray(result) ? [] : result.coveredVersions);
  }

  private sendItem(sessionId: string, item: PhoneProjectionItem): void {
    if (sessionId !== this.sessionId) return;
    const frame: Extract<PhoneProjectionFrame, { type: "phone_projection_event" }> = {
      type: "phone_projection_event", version: 1, sessionId, seq: ++this.seq, item: redactItem(item),
    };
    this.replay.push(frame);
    if (this.replay.length > MAX_REPLAY_FRAMES) this.replay.splice(0, this.replay.length - MAX_REPLAY_FRAMES);
    this.send(frame);
  }

  private sendError(code: Extract<PhoneProjectionFrame, { type: "phone_projection_error" }>["code"]): void {
    this.send({ type: "phone_projection_error", version: 1, code });
  }

  private send(frame: PhoneProjectionFrame): void {
    this.transport?.send(JSON.stringify(frame));
  }
}

function parseSubscribeRequest(text: string): SubscribeRequest | null {
  try {
    const raw = JSON.parse(text) as Record<string, unknown>;
    const allowedKeys = new Set(["type", "deviceId", "sessionId", "afterSeq"]);
    if (Object.keys(raw).some(key => !allowedKeys.has(key))) return null;
    if (raw.type !== "phone_projection_subscribe" || typeof raw.deviceId !== "string"
      || typeof raw.sessionId !== "string" || raw.sessionId.length === 0 || raw.sessionId.length > 256) return null;
    if (raw.afterSeq !== undefined && (!Number.isSafeInteger(raw.afterSeq) || (raw.afterSeq as number) < 0)) return null;
    return raw as unknown as SubscribeRequest;
  } catch { return null; }
}

function canonicalPhoneProjectionSource(): PhoneProjectionSource {
  return {
    highWater: sessionEventHighWater,
    snapshot: (sessionId, sinceVersion = 0) => {
      const messages = readRecentSessionMessages(sessionId).slice(-MAX_MESSAGES).flatMap(projectMessage);
      const operations = listOps()
        .filter(op => op.sessionId === sessionId)
        .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
        .slice(-MAX_OPERATIONS)
        .map(op => projectDurableOperation(op, {
          turns: readOpTurns(op.id),
          checkpoint: readCheckpoint(op.id),
          finalText: extractFinalAssistantText(op.id, MAX_TEXT_CHARS),
        }));
      const live = projectActiveChat(sessionId);
      const items = [...messages, ...operations, ...live];
      return {
        items,
        coveredVersions: snapshotCoveredVersions(items, sessionEventJournalSince(sessionId, sinceVersion)),
      };
    },
    subscribe: (sessionId, listener) => subscribeSessionEvents(sessionId, (event, version) => {
      const item = projectServerEvent(event);
      if (item) listener(item, version);
    }),
  };
}

export function snapshotCoveredVersions(
  items: PhoneProjectionItem[],
  journal: SessionEventJournalEntry[],
): number[] {
  const covered: number[] = [];
  for (const entry of journal) {
    const event = entry.event;
    if (event.type === "bg_op_progress") continue;
    const projected = projectServerEvent(event);
    if (!projected) continue;
    const represented = items.some(item => {
      if (projected.kind === "operation") {
        return item.kind === "operation" && item.opId === projected.opId && item.status === projected.status;
      }
      if (projected.kind === "notification") {
        return item.kind === "notification" && item.opId === projected.opId && item.status === projected.status;
      }
      if (projected.kind === "output") {
        const hasLiveOutput = items.some(candidate => candidate.kind === "output");
        const hasPersistedAnswer = items.some(candidate => candidate.kind === "conversation" && candidate.role === "assistant")
          && items.some(candidate => candidate.kind === "status"
            && ["done", "stopped", "error"].includes(candidate.state));
        return hasLiveOutput || hasPersistedAnswer;
      }
      return projected.kind === "status" && item.kind === "status" && item.state === projected.state;
    });
    if (represented) covered.push(entry.version);
  }
  return covered;
}

interface DurableOperationFacts {
  turns: OpTurnRow[];
  checkpoint: OpCheckpoint | null;
  finalText: string;
}

export function projectDurableOperation(op: Op, facts: DurableOperationFacts): PhoneProjectionItem {
  const state = op.canonical?.state ?? op.status;
  if (state === "succeeded" || state === "completed" || state === "failed"
    || state === "cancelled") {
    const status = state === "succeeded" ? "completed" : state;
    return redactItem({ kind: "notification", opId: op.id, status,
      summary: facts.finalText || op.lastFailureReason || status });
  }

  const latestTurn = facts.turns.at(-1);
  const tools = latestTurn?.toolCallSummary.map(call => call.tool).filter(Boolean) ?? [];
  const turnProgress = latestTurn
    ? `turn ${latestTurn.turnIdx} · ${tools.length > 0 ? tools.join(", ") : "thinking"}`
    : "";
  const progress = op.canonical?.suspension?.detail
    || turnProgress
    || facts.checkpoint?.lastSafeBoundary.label;
  return redactItem({
    kind: "operation",
    opId: op.id,
    status: state,
    task: op.task,
    ...(progress ? { progress } : {}),
  });
}

function projectActiveChat(sessionId: string): PhoneProjectionItem[] {
  const chat = activeChats.get(sessionId);
  if (!chat) return [];
  if (chat.done) {
    const terminal = [...chat.events].reverse()
      .map(projectServerEvent)
      .find((item): item is Extract<PhoneProjectionItem, { kind: "status" }> => item?.kind === "status");
    return [terminal ?? { kind: "status", state: "done" }];
  }
  return [
    { kind: "status", state: "started" },
    ...(chat.sawStream ? [{ kind: "output" as const, text: chat.streamText, replace: true }] : []),
  ];
}

function projectMessage(message: ChatCompletionMessageParam): PhoneProjectionItem[] {
  if (message.role !== "user" && message.role !== "assistant") return [];
  const text = typeof message.content === "string" ? message.content : "";
  return text ? [redactItem({ kind: "conversation", role: message.role, text })] : [];
}

function projectServerEvent(event: ServerEvent): PhoneProjectionItem | null {
  switch (event.type) {
    case "stream": return "replace" in event
      ? { kind: "output", text: event.text, replace: true }
      : { kind: "output", text: event.delta, replace: false };
    case "chat_op_started": return { kind: "status", state: "started" };
    case "done": return { kind: "status", state: "done" };
    case "stopped": return { kind: "status", state: "stopped", detail: event.reason };
    case "error": return { kind: "status", state: "error", detail: event.message };
    case "bg_op_queued": return { kind: "operation", opId: event.opId, status: "queued", task: event.task };
    case "bg_op_started": return { kind: "operation", opId: event.opId, status: "running", task: event.task };
    case "bg_op_progress": return { kind: "operation", opId: event.opId, status: "running", progress: event.line };
    case "bg_op_completed": return { kind: "notification", opId: event.opId, status: event.status, summary: event.summary };
    default: return null;
  }
}

function redactItem<T extends PhoneProjectionItem>(item: T): T {
  const clean = (value: string): string => redactString(value.slice(0, MAX_TEXT_CHARS)).redacted;
  if (item.kind === "conversation" || item.kind === "output") return { ...item, text: clean(item.text) };
  if (item.kind === "operation") return {
    ...item,
    ...(item.task ? { task: clean(item.task) } : {}),
    ...(item.progress ? { progress: clean(item.progress) } : {}),
  };
  if (item.kind === "notification") return { ...item, summary: clean(item.summary) };
  return item.detail ? { ...item, detail: clean(item.detail) } : item;
}
