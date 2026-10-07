/**
 * One-off repair of chat message times (scripts/backfill-session-times.ts).
 *
 * Until 2026-10-07 every save rewrote the session log and stamped every msg
 * row with the save time (5588722f stopped it), so a chat's rows mostly say
 * when it was last saved, not when anything was said. The true times survive
 * in the op records: each chat turn's op stores the user's exact message
 * (`task`) and when it started and finished. This matches each turn of each
 * session to its op and writes the op's times back: the user message gets
 * the op's start, the rows that answer it get its finish. A turn with no
 * matching op (a voice call, a pruned op) is marked `timeUnknown` rather than
 * given a guess. Every row other than a re-timed msg row is written back
 * byte-for-byte.
 */
import { randomUUID } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { atomicWriteFileSync } from "./utils.js";
import { isHarnessRow } from "../harness-rows.js";
import type { ChatCompletionMessageParam } from "openai/resources/chat/completions.js";
import type { SessionMessageRow } from "./session-log-rows.js";
import type { OpMessageRow } from "../canonical-loop/types.js";

interface TurnOp { opId: string; createdAt: string; completedAt?: string; task: string; used: boolean }
/** An op's own message rows (canonical-loop readOpMessages), history replays excluded. */
export type OpRowsReader = (opId: string) => OpMessageRow[];
export interface SessionTimePlan {
  sessionId: string;
  turns: number;
  matched: number;
  unknown: number;
  /** Per msg row, in file order: the time to write (null = unknown) and the
   *  op store's messageId for it when the turn's op has a row of that role. */
  times: Array<{ line: number; createdAt: string | null; id: string | null; preview: string; before: string }>;
}

function text(content: unknown): string {
  if (typeof content === "string") return content.trim();
  if (Array.isArray(content)) {
    return content.map((p) => (p && typeof p === "object" && "text" in p ? String((p as { text: unknown }).text) : "")).join(" ").trim();
  }
  return "";
}

/** Chat-turn ops grouped by session, oldest first. */
export function loadTurnOps(operationsDir: string): Map<string, TurnOp[]> {
  const bySession = new Map<string, TurnOp[]>();
  if (!existsSync(operationsDir)) return bySession;
  for (const dir of readdirSync(operationsDir)) {
    if (!dir.startsWith("op_chat_turn_")) continue;
    try {
      const op = JSON.parse(readFileSync(join(operationsDir, dir, "operation.json"), "utf-8")) as
        { sessionId?: string; task?: string; createdAt?: string; completedAt?: string };
      if (!op.sessionId || typeof op.task !== "string" || !op.createdAt) continue;
      const list = bySession.get(op.sessionId) ?? [];
      list.push({ opId: dir, createdAt: op.createdAt, completedAt: op.completedAt, task: op.task.trim(), used: false });
      bySession.set(op.sessionId, list);
    } catch { /* unreadable op: no evidence */ }
  }
  for (const list of bySession.values()) list.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  return bySession;
}

const OP_ROLE: Record<string, string> = { user: "user", assistant: "assistant", tool: "tool_result", system: "system" };

export function planSessionTimes(sessionId: string, logText: string, ops: TurnOp[], opRows: OpRowsReader = () => []): SessionTimePlan {
  const plan: SessionTimePlan = { sessionId, turns: 0, matched: 0, unknown: 0, times: [] };
  let turnTime: { start: string; end: string } | null = null;
  let inTurn = false;
  let turnRows: OpMessageRow[] = [];
  logText.split("\n").forEach((line, i) => {
    let row: SessionMessageRow;
    try { row = JSON.parse(line); } catch { return; }
    if (row.kind !== "msg" || !row.message) return;
    const m = row.message as ChatCompletionMessageParam;
    const opensTurn = m.role === "user" && !isHarnessRow(m);
    if (opensTurn) {
      inTurn = true;
      plan.turns++;
      const said = text(m.content);
      const op = ops.find((o) => !o.used && o.task === said);
      if (op) {
        op.used = true; plan.matched++; turnTime = { start: op.createdAt, end: op.completedAt ?? op.createdAt };
        try { turnRows = opRows(op.opId).filter((r) => !r.messageId.startsWith("hist-")); } catch { turnRows = []; }
      } else { plan.unknown++; turnTime = null; turnRows = []; }
    }
    const at = !inTurn || !turnTime ? null : opensTurn ? turnTime.start : turnTime.end;
    // The op's next row of the same role is this message's op identity.
    const k = turnRows.findIndex((r) => r.role === OP_ROLE[m.role]);
    const id = k >= 0 ? turnRows.splice(0, k + 1)[k].messageId : null;
    plan.times.push({ line: i, createdAt: at, id, preview: text(m.content).slice(0, 60), before: row.createdAt });
  });
  return plan;
}

/** Rewrite one session log per its plan. Rows other than re-timed msg rows
 *  are kept byte-for-byte. */
export function applySessionTimes(path: string, logText: string, plan: SessionTimePlan): void {
  const lines = logText.split("\n");
  for (const t of plan.times) {
    const prev = JSON.parse(lines[t.line]) as SessionMessageRow;
    // Same key order as the session writer (message, then provenance), so a
    // re-run — or the app's next save — rewrites nothing.
    const row: SessionMessageRow = {
      kind: "msg",
      message: prev.message,
      // An id, once written, is the row's identity for good.
      id: prev.id ?? t.id ?? `sm-${randomUUID()}`,
      createdAt: t.createdAt ?? prev.createdAt,
      ...(t.createdAt ? {} : { timeUnknown: true as const }),
    };
    lines[t.line] = JSON.stringify(row);
  }
  atomicWriteFileSync(path, lines.join("\n"));
}

export function planAllSessions(laxDir: string, opRows: OpRowsReader = () => []): SessionTimePlan[] {
  const sessionsDir = join(laxDir, "sessions");
  const ops = loadTurnOps(join(laxDir, "operations"));
  return readdirSync(sessionsDir).filter((f) => f.endsWith(".jsonl")).sort().map((f) => {
    const id = f.slice(0, -".jsonl".length);
    return planSessionTimes(id, readFileSync(join(sessionsDir, f), "utf-8"), ops.get(id) ?? [], opRows);
  });
}

/** Back up every session log, then apply every plan. Returns the backup dir. */
export function applyAllSessions(laxDir: string, plans: SessionTimePlan[], stamp: string): string {
  const sessionsDir = join(laxDir, "sessions");
  const backup = join(laxDir, "backups", `session-times-${stamp}`);
  mkdirSync(backup, { recursive: true, mode: 0o700 });
  for (const f of readdirSync(sessionsDir)) if (f.endsWith(".jsonl")) copyFileSync(join(sessionsDir, f), join(backup, f));
  for (const plan of plans) {
    const path = join(sessionsDir, `${plan.sessionId}.jsonl`);
    applySessionTimes(path, readFileSync(path, "utf-8"), plan);
  }
  return backup;
}
