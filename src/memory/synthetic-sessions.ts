// Session ids with these prefixes are generated/internal — memory
// consolidation (dream), scheduled jobs (cron), IDE workers (ide), and eval
// dry-runs — never real user conversations.
//
// Synthetic sessions must be excluded from THREE things, and the readers had
// drifted (session-helpers excluded 2 prefixes, routes/sessions 4, dream 0):
//   1. the UI session list (a throwaway shouldn't be adoptable),
//   2. the live memory index (don't embed internal scratch),
//   3. memory_dream's input — THE bug: dream globbed every *.jsonl including
//      its own dream-*.jsonl output, re-ingesting prior dreams' embedded
//      transcripts each run. That self-ingestion compounded exponentially
//      until a single session file hit 150 MB.
//
// One source of truth so the three readers can't diverge again. Matches on
// either a raw session id ("dream-123") or its filename ("dream-123.jsonl").
export const SYNTHETIC_SESSION_PREFIXES = ["dream-", "cron-", "ide-", "eval-"] as const;

export function isSyntheticSessionId(id: string): boolean {
  return SYNTHETIC_SESSION_PREFIXES.some((p) => id.startsWith(p));
}
