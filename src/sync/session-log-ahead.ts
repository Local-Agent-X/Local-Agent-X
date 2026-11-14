import { statSync } from "node:fs";

import { readSessionLogRows, sessionLogMeta, type SessionLogRow } from "../memory/session-log-rows.js";

/**
 * Whether one copy of a session log holds more of the conversation than
 * another. One author per chat, so the copy with more message rows is the
 * later one; a tie goes to the later updatedAt. Byte size used to stand in for
 * "later", but row size varies with what a row records (an id, a time
 * marker), so a copy could win on bytes while missing a message. Legacy
 * `.json` blobs, which the row reader does not cover, keep the size rule.
 *
 * Pull asks it of the mirror's copy against the local one; push asks it of the
 * local copy against the mirror's when it has no record of its own last push.
 */
export function sessionLogIsAhead(candidate: string, than: string): boolean {
  if (!candidate.endsWith(".jsonl")) return statSync(candidate).size > statSync(than).size;
  const a = readSessionLogRows(candidate) ?? [];
  const b = readSessionLogRows(than) ?? [];
  const msgs = (rows: SessionLogRow[]) => rows.filter((r) => r.kind === "msg").length;
  if (msgs(a) !== msgs(b)) return msgs(a) > msgs(b);
  return (sessionLogMeta(a)?.updatedAt ?? 0) > (sessionLogMeta(b)?.updatedAt ?? 0);
}
