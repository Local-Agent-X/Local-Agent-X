/**
 * The situational digest on a local wire: a row of the conversation, written
 * to op_messages on the rounds that carry one, instead of a per-request tail.
 *
 * A local runtime caches by token prefix, and a hybrid model (qwen3.8)
 * resumes only from checkpoints near the end of the last prompt. The digest
 * used to ride after the history as a tail the adapter re-sent in place within
 * an op (openai-compat/local-wire.ts), but it was never saved: the next
 * message's history lacked the row the last request ended with, and the
 * request diverged there. Measured 2026-11-03 on qwen3.8 27B: a message after a
 * digest re-read its whole 35k-token prompt, the digest having outgrown the
 * 512-token checkpoint window.
 *
 * Saved, it is history like any other row: every later round and message
 * reads it back in place, merged with an adjacent user row exactly as this
 * round's request merged it (build-input.ts collapseAdjacentUserMessages), so
 * each request extends the last. It is a harness row ("digest",
 * harness-rows.ts): hidden from the transcript, memory and retract.
 *
 * Cadence as before: the first round with something to say, then every
 * LOCAL_DIGEST_EVERY rounds; between them the model reads the last one.
 */
import type { Op } from "../../ops/types.js";
import { appendOpMessage, readOpMessages } from "../store.js";
import { buildSituationalAwareness } from "./situational-awareness.js";

/** Rounds between digests on a local wire. */
export const LOCAL_DIGEST_EVERY = 8;

/** Lanes that carry a digest at all (build-input.ts). */
export function digestLane(op: Op): boolean {
  return op.lane === "interactive" || op.lane === "agent" || op.lane === "background";
}

/** An op whose requests go to a local runtime. */
export function onLocalWire(op: Op): boolean {
  return op.contextPack?.routing?.preferredProvider === "local";
}

export function digestRowId(opId: string, turnIdx: number): string {
  return `sa-${opId}-${turnIdx}`;
}

/** Write this round's digest row when one is due, before the round's input
 *  is built (turn-loop.ts), so build-input reads it back as history. */
export async function writeLocalDigestRow(op: Op, turnIdx: number): Promise<void> {
  if (!onLocalWire(op) || !digestLane(op)) return;
  const rows = readOpMessages(op.id);
  const prefix = `sa-${op.id}-`;
  const written = rows.filter((r) => r.messageId.startsWith(prefix)).map((r) => r.turnIdx);
  // A retried round already holds its row; otherwise wait out the cadence.
  if (written.includes(turnIdx)) return;
  if (written.length > 0 && turnIdx - Math.max(...written) < LOCAL_DIGEST_EVERY) return;
  const digest = await buildSituationalAwareness(op, turnIdx);
  if (!digest) return;
  appendOpMessage({
    messageId: digestRowId(op.id, turnIdx),
    opId: op.id,
    turnIdx,
    seqInTurn: rows.filter((r) => r.turnIdx === turnIdx).reduce((max, r) => Math.max(max, r.seqInTurn + 1), 0),
    role: "user",
    content: { text: digest, kind: "digest" },
    createdAt: new Date().toISOString(),
  });
}
