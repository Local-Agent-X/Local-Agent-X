/**
 * The live workers the AGENTS sidebar shows, as one listing: every active canonical op
 * a chat session submitted, minus the types the sidebar suppresses.
 *
 * The sidebar is otherwise built from events alone (session-bridge-observer.ts), so a
 * client that connects mid-job never saw the job start, and one that was offline never
 * saw it end. This listing answers that client (chat-ws `workers_list`). The status and
 * progress-line wording are the observer's own, from the helpers below, so a snapshot
 * and a live event never describe one worker two ways.
 */
import { listActiveCanonicalOps } from "./active-ops.js";
import { aggregateOpUsage } from "./op-usage.js";
import { readLatestOpTurn } from "./store.js";
import { isDispatchFailure } from "./types.js";
import { isSidebarSuppressedOpType } from "./session-bridge-extractors.js";
import { readOp } from "../ops/op-store.js";
import { getSessionForOp, getTaskForOp } from "../ops/session-bridge.js";
import type { Op } from "../ops/types.js";

export type SuspendedWorkerStatus = "paused" | "blocked" | "stalled";

/** A paused op's status, by why it is suspended: waiting on something is `blocked`,
 *  no progress is `stalled`, anything else (the user, a pause request) is `paused`. */
export function suspendedWorkerStatus(op: Op | null | undefined): SuspendedWorkerStatus {
  const reason = op?.canonical?.suspension?.reason;
  return reason === "blocked" ? "blocked" : reason === "stalled" ? "stalled" : "paused";
}

/** The line a suspended op shows: why it stopped. The stored detail is also the
 *  message streamed into the chat, which opens with blank lines to set it apart
 *  there; shown as a worker's first line they left only "…" (phone, 2026-10-22). */
export function suspensionLine(op: Op | null | undefined): string {
  return op?.canonical?.suspension?.detail?.trim() || "Operation paused";
}

/** What a committed turn did: its tool names, each flagged if it failed, or
 *  "thinking" for a turn with no tools. */
export function turnProgressLine(turnIdx: number, tools: { tool: string; status?: string }[]): string {
  const summary = tools.length > 0
    ? tools.map((t) => (isDispatchFailure(t.status) ? `${t.tool} ✗` : t.tool)).join(", ")
    : "thinking";
  return `✓ turn ${turnIdx} · ${summary}`;
}

export interface LiveWorker {
  opId: string;
  /** The conversation the op reports to. */
  sessionId: string;
  task: string;
  status: "queued" | "running" | SuspendedWorkerStatus;
  opType?: string;
  parentOpId?: string;
  startedAt?: string;
  lastLine?: string;
  totalTokens?: number;
}

export function listLiveWorkers(): LiveWorker[] {
  const out: LiveWorker[] = [];
  for (const active of listActiveCanonicalOps()) {
    // The observer surfaces only ops a session submitted; the same ones are listed here.
    const sessionId = getSessionForOp(active.opId) ?? active.sessionId;
    if (!sessionId) continue;
    const op = readOp(active.opId);
    if (!op || (op.type && isSidebarSuppressedOpType(op.type))) continue;

    const status = active.state === "queued" ? "queued" : active.state === "paused" ? suspendedWorkerStatus(op) : "running";
    let lastLine: string | undefined;
    if (status !== "queued" && status !== "running") {
      lastLine = suspensionLine(op);
    } else {
      const turn = readLatestOpTurn(active.opId);
      if (turn) lastLine = turnProgressLine(turn.turnIdx, turn.toolCallSummary);
    }
    const usage = aggregateOpUsage(active.opId);

    out.push({
      opId: active.opId,
      sessionId,
      task: getTaskForOp(active.opId) ?? op.task ?? "",
      status,
      ...(op.type ? { opType: op.type } : {}),
      ...(op.parentOpId ? { parentOpId: op.parentOpId } : {}),
      ...(typeof op.startedAt === "string" ? { startedAt: op.startedAt } : {}),
      ...(lastLine ? { lastLine } : {}),
      ...(usage.sawAnyUsage ? { totalTokens: usage.usageInputTokens + usage.usageOutputTokens } : {}),
    });
  }
  return out;
}
