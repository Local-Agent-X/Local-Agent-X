/**
 * The local wire as a strict extension: every round of an op sends the
 * previous round's request byte for byte, then the rows new since, so the
 * runtime can reuse its whole cache.
 *
 * Why it must be STRICT: qwen3.6 (`qwen35`) is a hybrid model, recurrent state
 * on three of every four layers, and a recurrent state cannot be rewound to
 * where two prompts diverge. llama.cpp resumes such a model only from
 * checkpoints it saves near the end of each prompt, so a request that drops or
 * rewrites ANY row near the end of the last one is re-read from token zero
 * ("forcing full prompt re-processing due to lack of cache data", Ollama
 * 0.40.6). The per-round tail (the situational digest and the recalled
 * per-op sections, both regenerated every round) was dropped and replaced
 * every round, so on Terminal-Bench 2.0 (2026-10-20) every turn of a long task
 * re-read the whole conversation: 105,714 tokens, ~48 s, every turn.
 *
 * So on the local wire the tail is append-only: a fresh one is sent on the
 * first round, then every LOCAL_TAIL_EVERY rounds, and each one sent stays
 * where it was. Between them the model reads the last one it was given. The
 * recalled per-op sections are the same every round, so only the first tail
 * carries them. A round whose durable rows are not an extension of the last
 * (compaction rewrote history) starts over; so does a round carrying a
 * redirect, whose row the loop may persist in its own form next round.
 */
import type { ChatCompletionMessageParam } from "openai/resources/chat/completions.js";

/** Rounds between fresh tails on the local wire. */
export const LOCAL_TAIL_EVERY = 8;

export interface LocalWireState {
  /** Exactly what was sent last round. */
  sent: ChatCompletionMessageParam[];
  /** How many of the op's durable rows that request carried. */
  durable: ChatCompletionMessageParam[];
  /** The round the last fresh tail went out on. */
  tailTurn: number;
}

export interface LocalWireRound {
  turnIdx: number;
  /** The op's durable rows: history without the per-round tail. */
  durable: ChatCompletionMessageParam[];
  /** This round's tail with the recalled per-op sections, for a first round. */
  tailWithContext: ChatCompletionMessageParam[];
  /** This round's tail without them, for every later one. */
  tailAlone: ChatCompletionMessageParam[];
  /** A redirect rides this round: send it fresh, and keep no state. */
  redirect: boolean;
}

const same = (a: ChatCompletionMessageParam, b: ChatCompletionMessageParam) => JSON.stringify(a) === JSON.stringify(b);

function extendsDurable(prev: LocalWireState, durable: ChatCompletionMessageParam[]): boolean {
  if (durable.length < prev.durable.length) return false;
  return prev.durable.every((row, i) => same(row, durable[i]));
}

/** The request for this round, and the state the next round builds on. */
export function extendLocalWire(prev: LocalWireState | null, round: LocalWireRound): { messages: ChatCompletionMessageParam[]; state: LocalWireState | null } {
  if (round.redirect) return { messages: [...round.durable, ...round.tailWithContext], state: null };
  if (!prev || !extendsDurable(prev, round.durable)) {
    const messages = [...round.durable, ...round.tailWithContext];
    return { messages, state: { sent: messages, durable: round.durable, tailTurn: round.turnIdx } };
  }
  const due = round.turnIdx < prev.tailTurn || round.turnIdx - prev.tailTurn >= LOCAL_TAIL_EVERY;
  const fresh = due ? round.tailAlone : [];
  const messages = [...prev.sent, ...round.durable.slice(prev.durable.length), ...fresh];
  return { messages, state: { sent: messages, durable: round.durable, tailTurn: fresh.length > 0 ? round.turnIdx : prev.tailTurn } };
}
