/**
 * The provenance of each chat message — its id and when it was said — kept
 * once, beside the message rather than on it.
 *
 * A message object carries only role and content (it is sent to providers as
 * is), so its id and time live on its session-log row. Every consumer that
 * needs to know when or where something was said — the search index, facts
 * extracted from a chat, a recall citing a message — reads it from the row,
 * which is filled here and nowhere else:
 *   - a chat turn records the op store's own messageId and createdAt for the
 *     rows it adopts (canonical-run.ts), so a session row and its op row share
 *     one identity and one time;
 *   - the session reader records what each row says;
 *   - the writer persists what was recorded and, for a message nothing
 *     recorded (a path that builds messages itself), mints an id and stamps
 *     the save time — once, so a later save keeps it.
 * Until 2026-10-07 the writer stamped every row with each save's time and no
 * row had an id; a search then dated a message by the day its chat began and
 * the agent gave up a correct claim (chat-muyhjxcz).
 *
 * Keyed by the message object, which the session cache keeps alive across
 * turns. Leaf module.
 */
import { randomUUID } from "node:crypto";

export interface MessageProvenance {
  id: string;
  createdAt: string;
  /** The recorded time is known to be wrong (pre-2026-10-07 re-stamp that no
   *  op record recovered); createdAt then says when the row was last written. */
  timeUnknown?: true;
}

const provenance = new WeakMap<object, Partial<MessageProvenance>>();

/** Record what is known about a message: from its log row, or from the op
 *  row a chat turn adopted it from. Later calls fill fields, never erase. */
export function recordMessageProvenance(message: object, known: Partial<MessageProvenance>): void {
  const prev = provenance.get(message) ?? {};
  provenance.set(message, {
    id: prev.id ?? known.id,
    createdAt: prev.createdAt ?? known.createdAt,
    timeUnknown: prev.timeUnknown ?? known.timeUnknown,
  });
}

export function messageProvenance(message: object): Partial<MessageProvenance> | undefined {
  return provenance.get(message);
}

/** The provenance to persist for a message, minting what is missing once. */
export function provenanceForWrite(message: object, now: string): MessageProvenance {
  const known = provenance.get(message) ?? {};
  const out: MessageProvenance = {
    id: known.id ?? `sm-${randomUUID()}`,
    createdAt: known.createdAt ?? now,
    ...(known.timeUnknown ? { timeUnknown: true as const } : {}),
  };
  provenance.set(message, out);
  return out;
}
