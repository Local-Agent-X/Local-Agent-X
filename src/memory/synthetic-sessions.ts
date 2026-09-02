// Session ids with these prefixes are generated/internal — memory
// consolidation (dream), scheduled jobs (cron), IDE workers (ide), eval
// dry-runs, and skill-review cycles — never real user conversations.
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
//
// `eval_` has an UNDERSCORE: routes/chat.ts mints it via randomId("eval") and
// util/ids.ts formats `${prefix}_${body}`. This list said `eval-` (dash) from
// f6e5f7b0 (2026-06-09) until 2026-08-31 — a dead filter, so eval throwaways
// surfaced in the sidebar and were embedded into the live memory index.
//
// `skill-review-` mirrors background-jobs/skill-review.ts
// SKILL_REVIEW_SESSION_PREFIX (added 2026-09-01: skill-review transcripts
// are internal scratch exactly like dream output — prefix-pinned against the
// minter in test/synthetic-sessions.test.ts like the others).
export const SYNTHETIC_SESSION_PREFIXES = ["dream-", "cron-", "ide-", "eval_", "skill-review-"] as const;

export function isSyntheticSessionId(id: string): boolean {
  return SYNTHETIC_SESSION_PREFIXES.some((p) => id.startsWith(p));
}

// ── Chat-list hiding — the UI concern, kept separate from "headless" ──
//
// Hidden from user-facing CHAT LISTS: the live active_chats listing
// (chat-ws/broadcast.ts listActiveChatIds, sent on broadcast AND in the
// on-connect snapshot) and cross-session search (/api/sessions/search). An
// id in active_chats makes the browser mint a sidebar row for it
// (chat-stream-store-approvals.js setActiveSidebarSet → ensure()), so a
// cron-/dream-/eval_/skill-review- id there IS a fake chat.
//
// Derived from the synthetic list minus `ide-`: ide- chats are live
// user-facing chats over the chat WS (the IDE panel) — they keep their live
// badge and stay searchable, while remaining synthetic for memory ingestion
// and the persisted sidebar list (/api/sessions filters the full synthetic
// set above; deliberate — IDE chats have their own surface).
//
// This predicate must NEVER feed interrupt suppression. That is the other
// concern — chat-ws/broadcast.ts isHeadlessSession (eval_/skill-review-/
// dream- only) — and cron- is deliberately absent there: a cron job is a
// USER-SCHEDULED task whose failure must still nudge/notify
// (test/idle-nudge-headless.test.ts pins it). hidden ⊃ headless is pinned in
// test/chat-ws-headless-filter.test.ts.
export const CHAT_LIST_HIDDEN_PREFIXES: readonly string[] =
  SYNTHETIC_SESSION_PREFIXES.filter((p) => p !== "ide-");

export function isHiddenFromChatLists(id: string): boolean {
  return CHAT_LIST_HIDDEN_PREFIXES.some((p) => id.startsWith(p));
}
