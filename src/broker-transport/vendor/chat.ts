// Chat, carried on the `chat` data channel (link.ts). The desktop relays the channel to
// its own chat socket, so these are the desktop's chat frames: the phone sends
// chat/subscribe/stop/inject/approval_response and receives `event` envelopes.
//
// The desktop's event union is larger than this (its web UI renders agents, background
// ops and more). This file is the part the phone reads; the desktop checks at compile
// time that every event it emits under these types fits these shapes.

import { asNumber, asRecord, asString } from "./guards.js";
import { parseApprovalEvent } from "./approval.js";
import type { ApprovalRequestedEvent, ApprovalResolvedEvent, ApprovalResponseFrame, ApprovalTimeoutEvent } from "./approval.js";

/** How a tool call ended (or that it is still running). */
export type ToolResultStatus = "ok" | "error" | "blocked" | "declined" | "timeout" | "running";
const TOOL_STATUSES: readonly string[] = ["ok", "error", "blocked", "declined", "timeout", "running"];

export type ToolRiskLevel = "low" | "medium" | "high";
const RISK_LEVELS: readonly string[] = ["low", "medium", "high"];

export type TurnUsage = { promptTokens: number; completionTokens: number; totalTokens: number };

// ── desktop → phone ──

/** Append `delta` to the reply. `boundary` (replay only) marks that a tool ran just
 *  before this delta, so it starts a new block of the turn's timeline. */
export type StreamDeltaEvent = { type: "stream"; delta: string; boundary?: true };
/** Replace the reply's text with `text` (also the wipe before a replay). */
export type StreamReplaceEvent = { type: "stream"; replace: true; text: string };
/** The model's thinking, on its own lane: shown collapsed, never persisted. `boundary`
 *  (replay only) marks that a tool ran just before this delta. */
export type ReasoningDeltaEvent = { type: "reasoning"; delta: string; boundary?: true };
/** Replace the thinking lane with `text` (the replay wipe sends ""). */
export type ReasoningReplaceEvent = { type: "reasoning"; replace: true; text: string };
export type ToolStartEvent = {
  type: "tool_start";
  toolName: string;
  toolCallId?: string;
  args: unknown;
  riskLevel?: ToolRiskLevel;
  context?: string;
  requiresApproval?: boolean;
};
export type ToolProgressEvent = { type: "tool_progress"; toolName: string; toolCallId?: string; message: string };
export type ToolEndEvent = {
  type: "tool_end";
  toolName: string;
  toolCallId?: string;
  result: string;
  allowed: boolean;
  status?: ToolResultStatus;
};
/** The turn finished. `opId` names it, so a resubscribe can say it already holds it. */
export type DoneEvent = { type: "done"; usage: TurnUsage; opId?: string };
/** The turn stopped early (abort, ceiling or loop guard). */
export type StoppedEvent = { type: "stopped"; reason: string; debug?: string; firedBy?: string };
export type ChatErrorEvent = { type: "error"; message: string };
/** A message sent mid-turn was queued for the running turn. */
export type InjectQueuedEvent = { type: "inject_queued"; injectId: string };
/** The running turn took it in. On a replay, `message` carries its text. */
export type InjectConsumedEvent = { type: "inject_consumed"; injectId: string; message?: string };

export type ChatServerEvent =
  | StreamDeltaEvent
  | StreamReplaceEvent
  | ReasoningDeltaEvent
  | ReasoningReplaceEvent
  | ToolStartEvent
  | ToolProgressEvent
  | ToolEndEvent
  | DoneEvent
  | StoppedEvent
  | ChatErrorEvent
  | ApprovalRequestedEvent
  | ApprovalResolvedEvent
  | ApprovalTimeoutEvent
  | InjectQueuedEvent
  | InjectConsumedEvent;

/** The envelope every chat event arrives in. */
export type ChatEventFrame = { type: "event"; sessionId: string; event: ChatServerEvent };

// ── phone → desktop ──

/** An attachment on a user message. Images carry a base64 `dataUrl`. */
export type ChatAttachment = {
  name: string;
  size: number;
  type: string;
  isImage: boolean;
  url: string | null;
  dataUrl: string | null;
};

/** A user message. `projectId` files the session under a project; null unfiles it. */
export type ChatSendFrame = {
  type: "chat";
  sessionId: string;
  message: string;
  attachments: ChatAttachment[];
  projectId: string | null;
};

/** Subscribe to a session's events. The optional fields say what the client already
 *  holds, so the desktop's replay skips a finished turn instead of sending it twice:
 *  the server time its history was read at, and the op of the last `done` it received. */
export type SubscribeFrame = { type: "subscribe"; sessionId: string; historyAsOf?: number; doneOpId?: string };

/** Abort the session's running turn. */
export type ChatStopFrame = { type: "stop"; sessionId: string };

/** A message for the turn that is running now. `injectId` (client-made) ties the
 *  inject_queued / inject_consumed events back to it. A plain `chat` frame sent
 *  mid-turn is taken in the same way, but without an id to follow. */
export type InjectFrame = { type: "inject"; sessionId: string; message: string; injectId: string };

export type ChatOutboundFrame = ChatSendFrame | SubscribeFrame | ChatStopFrame | InjectFrame | ApprovalResponseFrame;

// ── parser ──

function parseEvent(raw: Record<string, unknown>): ChatServerEvent | null {
  switch (raw.type) {
    case "stream": {
      if (raw.replace === true) {
        const text = asString(raw.text);
        return text === null ? null : { type: "stream", replace: true, text };
      }
      const delta = asString(raw.delta);
      if (delta === null) return null;
      return raw.boundary === true ? { type: "stream", delta, boundary: true } : { type: "stream", delta };
    }
    case "reasoning": {
      if (raw.replace === true) {
        const text = asString(raw.text);
        return text === null ? null : { type: "reasoning", replace: true, text };
      }
      const delta = asString(raw.delta);
      if (delta === null) return null;
      return raw.boundary === true ? { type: "reasoning", delta, boundary: true } : { type: "reasoning", delta };
    }
    case "approval_requested":
    case "approval_resolved":
    case "approval_timeout":
      return parseApprovalEvent(raw);
    case "inject_queued":
    case "inject_consumed": {
      const injectId = asString(raw.injectId);
      if (injectId === null) return null;
      if (raw.type === "inject_queued") return { type: "inject_queued", injectId };
      const message = asString(raw.message);
      return message === null ? { type: "inject_consumed", injectId } : { type: "inject_consumed", injectId, message };
    }
    case "tool_start": {
      const toolName = asString(raw.toolName);
      if (toolName === null) return null;
      const ev: ToolStartEvent = { type: "tool_start", toolName, args: raw.args };
      const toolCallId = asString(raw.toolCallId);
      if (toolCallId !== null) ev.toolCallId = toolCallId;
      if (typeof raw.riskLevel === "string" && RISK_LEVELS.includes(raw.riskLevel)) ev.riskLevel = raw.riskLevel as ToolRiskLevel;
      const context = asString(raw.context);
      if (context !== null) ev.context = context;
      if (typeof raw.requiresApproval === "boolean") ev.requiresApproval = raw.requiresApproval;
      return ev;
    }
    case "tool_progress": {
      const toolName = asString(raw.toolName);
      const message = asString(raw.message);
      if (toolName === null || message === null) return null;
      const ev: ToolProgressEvent = { type: "tool_progress", toolName, message };
      const toolCallId = asString(raw.toolCallId);
      if (toolCallId !== null) ev.toolCallId = toolCallId;
      return ev;
    }
    case "tool_end": {
      const toolName = asString(raw.toolName);
      const result = asString(raw.result);
      if (toolName === null || result === null) return null;
      // An omitted `allowed` means allowed.
      const ev: ToolEndEvent = { type: "tool_end", toolName, result, allowed: raw.allowed !== false };
      const toolCallId = asString(raw.toolCallId);
      if (toolCallId !== null) ev.toolCallId = toolCallId;
      if (typeof raw.status === "string" && TOOL_STATUSES.includes(raw.status)) ev.status = raw.status as ToolResultStatus;
      return ev;
    }
    case "done": {
      const usage = asRecord(raw.usage);
      const ev: DoneEvent = {
        type: "done",
        usage: {
          promptTokens: asNumber(usage?.promptTokens) ?? 0,
          completionTokens: asNumber(usage?.completionTokens) ?? 0,
          totalTokens: asNumber(usage?.totalTokens) ?? 0,
        },
      };
      const opId = asString(raw.opId);
      if (opId !== null) ev.opId = opId;
      return ev;
    }
    case "stopped": {
      const reason = asString(raw.reason);
      if (reason === null) return null;
      const ev: StoppedEvent = { type: "stopped", reason };
      const debug = asString(raw.debug);
      if (debug !== null) ev.debug = debug;
      const firedBy = asString(raw.firedBy);
      if (firedBy !== null) ev.firedBy = firedBy;
      return ev;
    }
    case "error": {
      const message = asString(raw.message);
      return message === null ? null : { type: "error", message };
    }
    default:
      return null;
  }
}

/** An inbound chat frame for `sessionId`, or null for any other frame type, another
 *  session, or an event this contract does not model. */
export function parseChatFrame(raw: unknown, sessionId: string): ChatEventFrame | null {
  const msg = asRecord(raw);
  if (msg === null || msg.type !== "event" || msg.sessionId !== sessionId) return null;
  const eventRaw = asRecord(msg.event);
  const event = eventRaw === null ? null : parseEvent(eventRaw);
  return event === null ? null : { type: "event", sessionId, event };
}
