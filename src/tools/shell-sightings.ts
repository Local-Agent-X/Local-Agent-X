/**
 * What the session's recent shell commands showed the model, so the
 * stale-read guard can tell a file the model has seen from one it has not.
 *
 * The guard (tool-execution/run-sandboxed.ts) refuses to overwrite or edit a
 * file "this session hasn't read", and only the `read` tool and the model's own
 * writes counted as reading (read-state.ts). Models routinely read a whole tree
 * in one shell command instead (`for f in src/*.ts; do cat "$f"; done`), and
 * every later write was refused until the file was read again: about 18 of
 * the 26 refusals in the 2026-11-13 LAX-vs-Claude-Code run, one wasted step per
 * file. Parsing the command to learn which files it printed is not reliable
 * (globs, loops, variables), so this decides by CONTENT: a file whose entire
 * current text appears in output the model was given has been seen, exactly.
 * A clipped or partial print does not contain the whole text, so it earns
 * nothing, and the guard's protection is unchanged.
 *
 * Only what the model was delivered is kept (the result after redaction), per
 * session, bounded, in memory: a restart forgets it, and the next refusal is
 * the honest fallback.
 */

const MAX_OUTPUTS = 30;
const MAX_CHARS = 2 * 1024 * 1024;
/** Sessions kept; the least recently active is dropped past this. */
const MAX_SESSIONS = 32;

const recent = new Map<string, string[]>();

const normalize = (s: string): string => s.replace(/\r\n/g, "\n");

/** Remember a shell result the model was given. */
export function recordShellOutput(sessionId: string | undefined, delivered: string): void {
  if (!delivered) return;
  const key = sessionId || "default";
  const list = recent.get(key) ?? [];
  list.push(normalize(delivered));
  let total = list.reduce((n, s) => n + s.length, 0);
  while (list.length > MAX_OUTPUTS || (total > MAX_CHARS && list.length > 1)) total -= list.shift()!.length;
  recent.delete(key); // re-insert: Map order is the recency order
  recent.set(key, list);
  if (recent.size > MAX_SESSIONS) recent.delete(recent.keys().next().value as string);
}

/** Whether `content` (a file's current text) appeared whole in a recent shell
 *  result this session was given. An empty file proves nothing. */
export function shellShowedContent(sessionId: string | undefined, content: string): boolean {
  const text = normalize(content).replace(/\s+$/, "");
  if (!text) return false;
  return (recent.get(sessionId || "default") ?? []).some((out) => out.includes(text));
}

/** Test-only: forget everything, as a restart does. */
export function _resetShellSightingsForTest(): void {
  recent.clear();
}
