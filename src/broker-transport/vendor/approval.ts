// Tool approvals, carried on the `chat` channel (chat.ts). The desktop asks before a
// risky tool runs; whichever client answers first decides. An unanswered request is
// denied when `expiresAt` passes, and a new user message denies every pending request
// in that session ("superseded").

import { asNumber, asRecord, asString } from "./guards.js";

/** What the tool would do, for the approval card. The desktop's previews carry more
 *  fields; these are the ones a card needs. */
export type ApprovalPreview =
  | { kind: "file"; path: string; diff: string; lineCount: { added: number; removed: number }; truncated: boolean }
  | { kind: "shell"; cmd: string; cwd: string; explanation?: string }
  | { kind: "network"; method: string; url: string; domain: string; bodyPreview: string; bodyTruncated: boolean }
  | { kind: "money"; amount: number; currency: string; recipient: string; formatted: string }
  | { kind: "publish-review"; status: string; command: string; summary: string; overrideLabel?: string };

/** A tool is waiting for the user's yes or no. */
export type ApprovalRequestedEvent = {
  type: "approval_requested";
  approvalId: string;
  toolName: string;
  toolCallId?: string;
  /** Why this call needs a yes, in plain words. */
  context: string;
  /** The tool's arguments as JSON, cut short. */
  argsPreview: string;
  preview?: ApprovalPreview;
  /** When the desktop denies it on its own (epoch ms). */
  expiresAt?: number;
  /** Whether "allow for the rest of this session" may be offered. */
  rememberable?: boolean;
};

/** The request was answered (by any client), timed out, or superseded by a new message. */
export type ApprovalResolvedEvent = {
  type: "approval_resolved";
  approvalId: string;
  toolName: string;
  approved: boolean;
  reason?: "declined" | "timeout" | "superseded";
};

/** Nobody answered before `expiresAt`. */
export type ApprovalTimeoutEvent = { type: "approval_timeout"; approvalId: string; toolName: string; toolCallId?: string };

/** Phone → desktop: the answer. */
export type ApprovalResponseFrame = {
  type: "approval_response";
  approvalId: string;
  approved: boolean;
  rememberForSession: boolean;
};

export function buildApprovalResponse(approvalId: string, approved: boolean, rememberForSession = false): ApprovalResponseFrame {
  return { type: "approval_response", approvalId, approved, rememberForSession };
}

function parsePreview(raw: unknown): ApprovalPreview | null {
  const p = asRecord(raw);
  if (p === null) return null;
  const s = (k: string): string | null => asString(p[k]);
  switch (p.kind) {
    case "file": {
      const path = s("path");
      const diff = s("diff");
      const lc = asRecord(p.lineCount);
      const added = asNumber(lc?.added);
      const removed = asNumber(lc?.removed);
      return path !== null && diff !== null && added !== null && removed !== null
        ? { kind: "file", path, diff, lineCount: { added, removed }, truncated: p.truncated === true }
        : null;
    }
    case "shell": {
      const cmd = s("cmd");
      const cwd = s("cwd");
      if (cmd === null || cwd === null) return null;
      const explanation = s("explanation");
      return explanation === null ? { kind: "shell", cmd, cwd } : { kind: "shell", cmd, cwd, explanation };
    }
    case "network": {
      const method = s("method");
      const url = s("url");
      const domain = s("domain");
      const bodyPreview = s("bodyPreview");
      return method !== null && url !== null && domain !== null && bodyPreview !== null
        ? { kind: "network", method, url, domain, bodyPreview, bodyTruncated: p.bodyTruncated === true }
        : null;
    }
    case "money": {
      const amount = asNumber(p.amount);
      const currency = s("currency");
      const recipient = s("recipient");
      const formatted = s("formatted");
      return amount !== null && currency !== null && recipient !== null && formatted !== null
        ? { kind: "money", amount, currency, recipient, formatted }
        : null;
    }
    case "publish-review": {
      const status = s("status");
      const command = s("command");
      const summary = s("summary");
      if (status === null || command === null || summary === null) return null;
      const overrideLabel = s("overrideLabel");
      return overrideLabel === null
        ? { kind: "publish-review", status, command, summary }
        : { kind: "publish-review", status, command, summary, overrideLabel };
    }
    default:
      return null;
  }
}

/** One of the approval events, or null. An unknown preview kind leaves the card
 *  without a preview (it still shows `context` and `argsPreview`). */
export function parseApprovalEvent(raw: Record<string, unknown>): ApprovalRequestedEvent | ApprovalResolvedEvent | ApprovalTimeoutEvent | null {
  const approvalId = asString(raw.approvalId);
  const toolName = asString(raw.toolName);
  if (approvalId === null || toolName === null) return null;
  const toolCallId = asString(raw.toolCallId);
  switch (raw.type) {
    case "approval_requested": {
      const ev: ApprovalRequestedEvent = {
        type: "approval_requested",
        approvalId,
        toolName,
        context: asString(raw.context) ?? "",
        argsPreview: asString(raw.argsPreview) ?? "",
      };
      if (toolCallId !== null) ev.toolCallId = toolCallId;
      const preview = parsePreview(raw.preview);
      if (preview !== null) ev.preview = preview;
      const expiresAt = asNumber(raw.expiresAt);
      if (expiresAt !== null) ev.expiresAt = expiresAt;
      if (typeof raw.rememberable === "boolean") ev.rememberable = raw.rememberable;
      return ev;
    }
    case "approval_resolved": {
      if (typeof raw.approved !== "boolean") return null;
      const ev: ApprovalResolvedEvent = { type: "approval_resolved", approvalId, toolName, approved: raw.approved };
      if (raw.reason === "declined" || raw.reason === "timeout" || raw.reason === "superseded") ev.reason = raw.reason;
      return ev;
    }
    case "approval_timeout": {
      const ev: ApprovalTimeoutEvent = { type: "approval_timeout", approvalId, toolName };
      if (toolCallId !== null) ev.toolCallId = toolCallId;
      return ev;
    }
    default:
      return null;
  }
}
