/**
 * Initial-prompt seeding for canonical-routed ops.
 *
 * The legacy worker (workers/worker-entry.ts) builds an initial user message
 * from `op.task` and a system prompt from `op.contextPack` before the first
 * model call. The canonical loop replays history from `op_messages` on every
 * turn — so without a seeded initial user message the first turn ships an
 * empty messages array to the adapter, and the model responds with the
 * "What would you like to work on?" placeholder observed in production
 * long-soak op-messages.jsonl files.
 *
 * `seedInitialUserMessage(op)` is the canonical seam that closes the gap.
 * It runs once, on the worker side after lease + running transition, before
 * the first `driveTurn`. Idempotent: re-entry on recovery sees a non-empty
 * op_messages and skips re-seeding.
 */
import { randomUUID } from "node:crypto";
import { appendOpMessage, readOpMessages } from "./store.js";
import { emit } from "./event-emitter.js";
import type { Op } from "../workers/types.js";
import type { OpMessageRow } from "./types.js";

/**
 * Render the initial user message content for `op`. Mirrors the legacy
 * worker's prompt construction (workers/worker-entry.ts) when the op's
 * contextPack carries the richer task fields. Falls back to a bare
 * `op.task` string when no extras are present.
 *
 * The shape is `{ text: string }` to match the canonical message-content
 * convention used by the Anthropic adapter (`extractText` reads
 * `content.text`).
 */
export function buildInitialUserContent(op: Op): { text: string } {
  const lines: string[] = [];
  const task = op.task ?? "";
  const pack = op.contextPack as Op["contextPack"] | undefined;
  const taskBlock = pack?.task;

  const description = (taskBlock?.description ?? "").trim();
  const baseTask = description.length > 0 ? description : task;
  if (baseTask) {
    lines.push(`## Task`);
    lines.push(baseTask);
  }

  const successCriteria = taskBlock?.successCriteria ?? [];
  if (successCriteria.length > 0) {
    lines.push("");
    lines.push("## Success criteria");
    for (const s of successCriteria) lines.push(`- ${s}`);
  }

  const constraints = taskBlock?.constraints ?? [];
  if (constraints.length > 0) {
    lines.push("");
    lines.push("## Constraints");
    for (const s of constraints) lines.push(`- ${s}`);
  }

  const notRedo = taskBlock?.notWhatToRedo ?? [];
  if (notRedo.length > 0) {
    lines.push("");
    lines.push("## Do NOT redo");
    for (const s of notRedo) lines.push(`- ${s}`);
  }

  const text = lines.length > 0 ? lines.join("\n") : (task || "(no task)");
  return { text };
}

/**
 * Append the initial user message to `op_messages` if it hasn't been seeded
 * yet. Returns true if a row was written, false if seeding was skipped
 * (idempotent on recovery / re-entry).
 *
 * Emits a `message_appended` canonical event so replay/reconnect clients
 * see the seeded turn input the same way they see post-turn messages.
 */
export function seedInitialUserMessage(op: Op): boolean {
  const existing = readOpMessages(op.id);
  if (existing.length > 0) return false;

  const row: OpMessageRow = {
    messageId: `um-${op.id}-init-${randomUUID().slice(0, 8)}`,
    opId: op.id,
    turnIdx: 0,
    seqInTurn: 0,
    role: "user",
    content: buildInitialUserContent(op),
    createdAt: new Date().toISOString(),
  };
  appendOpMessage(row);
  emit(op.id, "message_appended", {
    turnIdx: row.turnIdx,
    role: row.role,
    messageId: row.messageId,
  });
  return true;
}
