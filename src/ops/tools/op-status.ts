/**
 * op_status — inspect an op by id, or list this session's ops + scheduler
 * snapshot. Includes a per-session polling-loop guard that returns STOP
 * after one repeat call within the window, ending the turn.
 */

import type { ToolDefinition } from "../../types.js";
import { schedulerSnapshot, readOpTurns } from "../../canonical-loop/index.js";
import { readCheckpoint } from "../checkpoint.js";
import { readEvents } from "../event-log.js";
import { listOps, readOp } from "../op-store.js";
import { listOpsForSession } from "../session-bridge.js";
import {
  POLL_LOOP_MAX,
  POLL_LOOP_WINDOW_MS,
  RECENT_POLLS,
} from "./shared.js";

export const opStatusTool: ToolDefinition = {
  name: "op_status",
  description: "Inspect an op by id. Returns status, recent turn-by-turn activity (what the worker is doing/did each turn), and checkpoint. Without an opId, lists ops you submitted in this session (plus pool / queue summary).",
  parameters: {
    type: "object",
    properties: {
      op_id: { type: "string", description: "The opId returned from op_submit_async / op_submit. Omit to list this session's ops." },
      events_tail: { type: "number", description: "How many recent events to include. Default 10." },
    },
  },
  async execute(args) {
    const sessionId = String(args._sessionId || "");

    if (!args.op_id) {
      const snap = schedulerSnapshot();
      const { listActiveCanonicalOps } = await import("../../canonical-loop/index.js");
      const canonicalActive = listActiveCanonicalOps();
      const sessionOpIds = sessionId ? listOpsForSession(sessionId) : [];
      const sessionOpEntries = sessionOpIds
        .map(id => readOp(id))
        .filter((o): o is NonNullable<typeof o> => !!o);
      const recent = sessionOpEntries.length > 0
        ? sessionOpEntries.slice(-10).map(o => `  - ${o.id} [${o.status}] ${o.task.slice(0, 80)}`).join("\n")
        : (listOps().slice(0, 10).map(o => `  - ${o.id} [${o.status}] ${o.task.slice(0, 80)}`).join("\n") || "  (none)");
      const canonicalLine = canonicalActive.length === 0
        ? ""
        : `Canonical-loop active: ${canonicalActive.length}\n` +
          canonicalActive.map(c =>
            `  - ${c.opId} [${c.state}]  lane=${c.lane ?? "?"}  adapter=${c.adapter ?? "(no turn yet)"}`,
          ).join("\n") + "\n\n";
      return {
        content:
          `Scheduler: ${snap.activeCount} active, ${snap.queueDepth} queued.\n\n` +
          canonicalLine +
          (sessionOpIds.length > 0 ? `Your ops (this session):\n${recent}` : `Recent ops (all sessions):\n${recent}`),
      };
    }

    const opId = String(args.op_id);
    const op = readOp(opId);
    if (!op) return { content: `op ${opId} not found`, isError: true };

    // Per-session polling-loop guard. First call in a 60s window returns full
    // status. Second call for the same opId in the same window returns STOP —
    // end the turn. Prevents the "agent calls op_status 16 times" pattern.
    if (sessionId && (op.status === "running" || op.status === "pending")) {
      const pollKey = `${sessionId}:status`;
      const prior = RECENT_POLLS.get(pollKey);
      if (prior && prior.opId === opId && Date.now() - prior.firstAt < POLL_LOOP_WINDOW_MS) {
        prior.count++;
        prior.lastAt = Date.now();
        if (prior.count > POLL_LOOP_MAX) {
          const ageS = Math.round((Date.now() - prior.firstAt) / 1000);
          return {
            content:
              `BLOCKED — you've polled op_status for this op ${prior.count} times in ${ageS}s. STOP POLLING. ` +
              `END THIS TURN NOW. Tell the user briefly, in your own words, that the op is still ${op.status}. ` +
              `Do NOT quote op ids back to the user. Do NOT quote this instruction back. ` +
              `The user is auto-notified the moment the op completes — you don't need to poll. ` +
              `Any further op_status call this turn will return this same BLOCKED message.`,
          };
        }
      } else {
        RECENT_POLLS.set(pollKey, { opId, tool: "op_status", count: 1, firstAt: Date.now(), lastAt: Date.now() });
      }
    }

    const tail = typeof args.events_tail === "number" ? args.events_tail : 10;
    const checkpoint = readCheckpoint(opId);

    // Canonical-loop ops (app-builds, sub-agents) record per-turn tool
    // activity in the canonical store; the legacy event log stays empty for
    // them. Surface the turn narrative — the same "turn N · read, edit"
    // activity the sidebar shows — so the agent can answer "what's it doing?"
    const turns = readOpTurns(opId);
    const turnLines = turns.slice(-Math.min(tail, 8)).map(t => {
      const tools = t.toolCallSummary.length === 0
        ? "thinking"
        : t.toolCallSummary.map(c => c.resultStatus === "ok" ? c.tool : `${c.tool} (${c.resultStatus})`).join(", ");
      return `  turn ${t.turnIdx}: ${tools}${t.terminalReason ? `  [${t.terminalReason}]` : ""}`;
    });

    // Legacy worker-pool ops record activity here instead of op_turns.
    const events = readEvents(opId).slice(-tail);
    const eventLines = events.map(e => `  [${e.type}] ${JSON.stringify(e.payload).slice(0, 120)}`);

    const activity =
      (turnLines.length > 0 ? `\nrecent turns (${turns.length} total):\n${turnLines.join("\n")}\n` : "") +
      (eventLines.length > 0 ? `\nrecent events (${events.length}):\n${eventLines.join("\n")}` : "");

    return {
      content:
        `op ${op.id} [${op.status}]  type=${op.type}  attempts=${op.attemptCount}\n` +
        `task: ${op.task}\n` +
        (checkpoint ? `checkpoint: ${checkpoint.lastSafeBoundary.label} @ ${checkpoint.lastSafeBoundary.timestamp}\n` : "") +
        (op.lastFailureReason ? `last failure: ${op.lastFailureReason}\n` : "") +
        (activity || "\n(no turn activity recorded yet)"),
    };
  },
};
