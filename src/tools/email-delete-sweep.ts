/**
 * `email_delete`'s resumable sweep: ONE search, then as many batches as it takes.
 *
 * ── WHY THIS EXISTS (measured, n=46 against a real Gmail) ───────────────────
 * Connection reuse halved the latency of a delete and did not move the ~20%
 * error rate at all. Two causes, both real, both addressed here:
 *
 *  (a) THE MODEL NEVER USES THE CEILING. Raising MAX_BATCH from 200 to 1000
 *      changed a constant; the observed limits the model actually passed were
 *      50, 200, 250 and 500 — never 1000 — against match sets of 186, 227, 306,
 *      439 and 966. `limit` asks for a number the model has no basis for, and
 *      every wrong guess cost a full Gmail SEARCH and a refusal. A cursor asks
 *      for nothing: the tool hands back a token that means "the rest of THIS
 *      match set", and continuing costs no SEARCH because the uid list is
 *      already resolved.
 *
 *  (b) A UID THAT VANISHED WAS A HARD ERROR. Observed four times, shrinking as
 *      the agent retried: `0 of 130`, `0 of 30`, `0 of 10`, `0 of 4`. The agent
 *      searched, began deleting, and by the tail of the list those messages had
 *      already reached Trash. A message that is no longer in the folder is a
 *      delete that already happened — that is the OUTCOME THE CALLER ASKED FOR,
 *      so it is counted and reported, never failed. What stays a failure is the
 *      server saying no to a message that IS still there.
 *
 * ── THE STORE ───────────────────────────────────────────────────────────────
 * Shaped after src/tools/read-state.ts, which is this repo's canonical bounded
 * per-caller store: a Map with an explicit cap and least-recently-used
 * eviction. An unbounded cursor store is a memory leak, and a delete cursor
 * holds up to MAX_BATCH uids apiece, so the cap is not decoration.
 *
 * KEYED BY THE TOKEN, not by a session. `ToolDefinition.execute(args)` receives
 * a session only as the executor-injected `args._sessionId`, which src/auto-
 * build/tool.ts and src/agents/tools.ts both treat as optional because non-chat
 * callers do not stamp one. A store that keyed on it would silently degrade to
 * one shared bucket exactly where isolation mattered. The token is minted here,
 * is unguessable, and is the only handle anyone can present — so it is the key.
 *
 * The cursor CONVENTION — an opaque token echoed back inside the tool's own
 * output text, naming the exact next call — is recall-tool.ts's, deliberately.
 * What is NOT borrowed is its statelessness: recall's token encodes a position
 * and each call re-derives the list, which here would mean re-running the
 * SEARCH every page and would fix neither (a) nor its cost.
 */
import { randomBytes } from "node:crypto";
import type { ToolResult } from "../types.js";
import { fail, openFailure } from "./email-mutate-shared.js";
import { MailboxOpenError, type EmailHeader, type ImapSession } from "./email-imap.js";

/** Live sweeps held at once. Small on purpose: a sweep is a few minutes of one
 *  conversation, not a cache, and each holds up to MAX_BATCH uids. */
const MAX_SWEEPS = 16;
/** How long a cursor stays usable. Past this the mailbox has moved on enough
 *  that continuing is guesswork, and the honest answer is "search again". */
const SWEEP_TTL_MS = 15 * 60_000;
/** Version-tagged so a token from an older shape is REJECTED rather than
 *  half-understood. */
const TOKEN_PREFIX = "edc1.";

export interface Sweep {
  /** The folder the search ran in. Uids are per-mailbox, so this travels with
   *  them or they mean nothing. */
  folder: string;
  /** The mailbox's UIDVALIDITY when the set was resolved, or "" when the server
   *  did not report one. */
  uidValidity: string;
  /** Uids not yet acted on, in the order the server returned them. */
  remaining: number[];
  total: number;
  /** Messages the SERVER ENUMERATED as moved. Only that — a page the server
   *  accepted without a UIDPLUS map moved an unknown number, and counting the
   *  requested count here would make this a number that over-reports itself the
   *  first time anyone displays it. */
  moved: number;
  skipped: number;
  /** Messages handed to the server that it did NOT confirm moving: a confirmed
   *  shortfall (`moved < requested`) plus every page it never enumerated.
   *
   *  This is what makes the terminal claim honest. The sweep advances by the
   *  whole PAGE whatever the server did — otherwise a page the server keeps
   *  refusing loops forever — so reaching the end of `remaining` means "every
   *  uid was attempted", NOT "every message was moved". Those are the same
   *  sentence only when this counter is zero. */
  unconfirmed: number;
  lastUsedAt: number;
}

const sweeps = new Map<string, Sweep>();

function dropExpired(now: number): void {
  for (const [token, sweep] of sweeps) {
    if (now - sweep.lastUsedAt > SWEEP_TTL_MS) sweeps.delete(token);
  }
}

/** Bound the store: over the cap, the least recently used sweeps go. Their
 *  tokens then fail with "re-run the search", which is the same outcome as
 *  expiry and is why eviction is safe — a dropped cursor can never be mistaken
 *  for a finished one. */
function evictOverCap(): void {
  if (sweeps.size <= MAX_SWEEPS) return;
  const oldestFirst = [...sweeps.entries()].sort((a, b) => a[1].lastUsedAt - b[1].lastUsedAt);
  for (const [token] of oldestFirst.slice(0, sweeps.size - MAX_SWEEPS)) sweeps.delete(token);
}

/**
 * Start a sweep over an already-resolved match set and return its token, or
 * null when the set cannot safely be held across calls.
 *
 * NO EPOCH, NO CURSOR. A cursor's whole content is raw uids carried from one
 * call to the next, and UIDVALIDITY is the only evidence that those numbers
 * still name the same mail when the next call arrives. A server that reports
 * none can still be swept a batch at a time by the caller narrowing filters or
 * raising `limit` — that path resolves and moves inside ONE connection, where
 * the epoch adds nothing the presence check has not already established. What
 * it cannot have is a token that would assert an unverifiable fact minutes
 * later. Refused HERE, at the one place cursors are born, so no caller is ever
 * handed a cursor that a continuation would have to reject.
 */
export function openSweep(folder: string, uidValidity: string, uids: number[]): string | null {
  if (uidValidity === "") return null;
  const now = Date.now();
  dropExpired(now);
  const body = JSON.stringify({ f: folder, v: uidValidity, n: randomBytes(9).toString("base64url") });
  const token = `${TOKEN_PREFIX}${Buffer.from(body, "utf-8").toString("base64url")}`;
  sweeps.set(token, {
    folder, uidValidity, remaining: [...uids], total: uids.length, moved: 0, skipped: 0, unconfirmed: 0, lastUsedAt: now,
  });
  evictOverCap();
  return token;
}

/** What a token says about ITSELF, before the store is consulted: the folder it
 *  swept and the UIDVALIDITY it was resolved under. Carried in the token rather
 *  than only in the entry so a cursor aimed at the wrong folder is refused by
 *  reading the argument, not by trusting a lookup. */
export function readToken(token: string): { folder: string; uidValidity: string } | null {
  if (!token.startsWith(TOKEN_PREFIX)) return null;
  try {
    const decoded: unknown = JSON.parse(Buffer.from(token.slice(TOKEN_PREFIX.length), "base64url").toString("utf-8"));
    if (typeof decoded !== "object" || decoded === null) return null;
    const { f, v } = decoded as { f?: unknown; v?: unknown };
    if (typeof f !== "string" || typeof v !== "string" || f === "") return null;
    return { folder: f, uidValidity: v };
  } catch {
    return null;
  }
}

/** The live sweep for a token, or null when it expired, was evicted, or was
 *  never one of ours. Never "start a fresh one" — silently re-searching under a
 *  stale cursor would act on a set the caller never saw. */
export function resumeSweep(token: string): Sweep | null {
  const now = Date.now();
  dropExpired(now);
  const sweep = sweeps.get(token);
  if (!sweep) return null;
  sweep.lastUsedAt = now;
  return sweep;
}

/** Forget a sweep whose uids can no longer mean anything. */
export function closeSweep(token: string): void {
  sweeps.delete(token);
}

/** What a page did, in the terms the sweep accumulates. */
export interface PageTally {
  /** Messages the server ENUMERATED as moved. Never the requested count. */
  moved: number;
  /** Messages that were no longer in the folder — already deleted. */
  skipped: number;
  /** Messages handed to the server whose move it did not confirm. */
  unconfirmed: number;
}

/** The sweep's state after a page was committed. Returned as a SNAPSHOT rather
 *  than read back through `resumeSweep`, because the last page deletes the
 *  entry — and the last page is exactly the one whose totals decide whether the
 *  sweep may claim it finished the job. */
export interface PageCommit {
  /** True when uids remain to act on. */
  more: boolean;
  remaining: number;
  total: number;
  /** Running total of `PageTally.unconfirmed` over the whole sweep. Zero is the
   *  ONLY state in which "every message has been dealt with" is a true sentence. */
  unconfirmed: number;
}

/**
 * Advance past a page that was acted on.
 *
 * Called ONLY after a page succeeded: a page that FAILED leaves `remaining`
 * untouched, so the same cursor retries the same page rather than skipping mail
 * the caller asked to delete. A page that succeeded advances by its whole size
 * even when the server moved fewer than were asked — re-attempting mail a
 * server has already declined would loop the sweep forever — which is why the
 * shortfall has to be CARRIED instead of silently dropped.
 */
export function commitPage(token: string, pageSize: number, tally: PageTally): PageCommit | null {
  const sweep = sweeps.get(token);
  if (!sweep) return null;
  sweep.remaining = sweep.remaining.slice(pageSize);
  sweep.moved += tally.moved;
  sweep.skipped += tally.skipped;
  sweep.unconfirmed += tally.unconfirmed;
  sweep.lastUsedAt = Date.now();
  const commit: PageCommit = {
    more: sweep.remaining.length > 0,
    remaining: sweep.remaining.length,
    total: sweep.total,
    unconfirmed: sweep.unconfirmed,
  };
  if (!commit.more) sweeps.delete(token);
  return commit;
}

/** The sentence a dead cursor gets. One definition, because "re-run the search"
 *  is the only safe advice and it must never drift into "start over quietly". */
export const STALE_CURSOR_MESSAGE =
  "That `cursor` is no longer usable — a delete sweep is kept for 15 minutes and only the "
  + `${MAX_SWEEPS} most recent are held, so this one has expired or been dropped. Nothing was deleted, and this tool `
  + "will NOT quietly start a new sweep from a cursor it cannot verify. Re-run email_delete with the original "
  + "search filters to resolve the match set again.";

/** Test-only: clear the store so one case cannot see another's sweeps. */
export function _resetSweepsForTest(): void {
  sweeps.clear();
}

export interface PageRequest {
  folder: string;
  destination: string;
  /** The uids this call may act on. */
  targets: number[];
  /** What a uid that is not in the folder MEANS here. `refuse` for uids the
   *  CALLER supplied — absence is evidence they came from another folder, which
   *  no downstream check can recover. `skip` for uids this tool resolved itself
   *  in this folder — absence is evidence the message was already deleted. */
  onMissing: "refuse" | "skip";
  /** UIDVALIDITY these uids were resolved under, or "" when there is none to
   *  check against. */
  expectValidity: string;
  /** True when these uids CROSSED A CALL BOUNDARY (the cursor path), so an
   *  unreported epoch is not tolerable. See the rule at the check itself. */
  requireValidity?: boolean;
}

export type PageOutcome =
  | { ok: false; result: ToolResult; fatal: boolean }
  | {
    ok: true;
    /** The uids actually handed to the server. */
    uids: number[];
    requested: number;
    /** The server's own count, or null when it enumerated nothing. */
    moved: number | null;
    confirmed: boolean;
    /** Uids that were no longer in the folder — already deleted, not failures. */
    skipped: number[];
    headers: EmailHeader[];
  };

function refuse(result: ToolResult, fatal = false): PageOutcome {
  return { ok: false, result, fatal };
}

/**
 * Resolve one page in the folder, move what is still there, and report both
 * halves.
 *
 * The resolve is not an extra round trip — it REPLACES the message fetch the
 * search used to do (which asked for `source: true`, i.e. the full raw bytes of
 * up to MAX_BATCH messages, to build snippets a delete throws away). It is also
 * what makes bug (b) impossible to hit: uids that are gone are never handed to
 * the server at all, so there is no zero-move to misread.
 */
export async function movePage(session: ImapSession, req: PageRequest): Promise<PageOutcome> {
  let resolved: { headers: EmailHeader[]; uidValidity: string };
  try {
    resolved = await session.resolveUids(req.folder, req.targets);
  } catch (err) {
    if (err instanceof MailboxOpenError) return refuse(openFailure(err));
    return refuse(fail(`Refusing to delete: could not verify the messages in "${req.folder}": ${(err as Error).message}`));
  }

  // UIDVALIDITY: the one condition under which a held uid names DIFFERENT mail
  // rather than no mail. Deleting by coincidence after a renumbering is the
  // worst outcome available to this tool, so it fails loudly and fatally.
  //
  // MISSING validity splits by HOW FAR the uids travelled, because that is what
  // decides whether the epoch was carrying any weight:
  //
  //  · SINGLE-SHOT (uids the caller passed, or a filter set that fit in one
  //    call) — FAIL OPEN, deliberately. The resolve and the move happen inside
  //    ONE connection, moments apart, over uids this call just proved present.
  //    The epoch adds nothing that presence has not already established, and
  //    failing closed would refuse EVERY delete on a server that reports no
  //    UIDVALIDITY at all. Pinned by test so a change to `uidValidityOf` cannot
  //    widen it silently.
  //  · CONTINUATION (`requireValidity`) — REFUSE. Here the uids crossed a call
  //    boundary and up to fifteen minutes, and the epoch is the ONLY evidence
  //    they still name the same mail; without it the tool would be asserting a
  //    fact it cannot check, and a mailbox swapped underneath it would move
  //    messages the sweep never resolved and report success. This costs such a
  //    server nothing it had: `openSweep` refuses to mint a cursor without an
  //    epoch in the first place, so the reachable case here is a server that
  //    reported one at SEARCH time and stopped reporting it.
  if (req.requireValidity && (req.expectValidity === "" || resolved.uidValidity === "")) {
    return refuse(fail(
      `"${req.folder}" is not reporting a UIDVALIDITY, so there is no way to prove the uids this sweep is holding still name `
      + `the same messages they named when the search resolved them. IMAP uids are meaningful only within one validity epoch, `
      + `and continuing without it would risk deleting DIFFERENT mail that happens to carry those numbers now. `
      + `Nothing was deleted, and this cursor is discarded: re-run email_delete with the original search filters, narrowing them `
      + `(or raising \`limit\`) so each call resolves and moves the messages within it.`,
    ), true);
  }

  // Refused only when BOTH ends report a validity and they disagree — never
  // when either is unknown ON THE SINGLE-SHOT PATH, per the split above. That
  // is the rule the previous chunk's recorded TOCTOU residual named as the
  // correct one if it were ever taken, and it is taken here.
  //
  // WHAT REMAINS: the resolve and the move are still two SELECTs, so a
  // renumbering could land between THEM. It cannot cause a wrong delete the way
  // the old gap could — the uids handed to the move were proved present in the
  // epoch this check just verified, and a renumbering empties the mailbox of
  // them — but the residual is a gap, not zero.
  if (req.expectValidity !== "" && resolved.uidValidity !== "" && req.expectValidity !== resolved.uidValidity) {
    return refuse(fail(
      `"${req.folder}" has been RENUMBERED since these uids were resolved (UIDVALIDITY ${req.expectValidity} → ${resolved.uidValidity}). `
      + `IMAP guarantees uids are stable only within one validity epoch, so every uid held here now names a different message or none at all. `
      + `Nothing was deleted, and nothing will be: re-run email_delete with the original search filters to resolve the set again.`,
    ), true);
  }

  const present = new Set(resolved.headers.map((h) => h.uid));
  const missing = req.targets.filter((u) => !present.has(u));
  if (missing.length > 0 && req.onMissing === "refuse") {
    return refuse(fail(
      `Refusing to delete: ${missing.length} of the ${req.targets.length} uid(s) given are not in "${req.folder}" — ${missing.join(", ")}. `
      + `IMAP uids are per-folder, so a uid from one folder names a DIFFERENT message (or none) in another. `
      + `Pass \`folder\` naming the folder the uids came from, or re-run the search there to get its uids. Nothing was moved.`,
    ));
  }

  const uids = req.targets.filter((u) => present.has(u));
  const headers = resolved.headers.filter((h) => present.has(h.uid));
  // Nothing left to move is not a failure — it is the whole of bug (b). The
  // messages the caller asked to delete are not in the folder, which is what
  // "deleted" means here.
  if (uids.length === 0) {
    return { ok: true, uids, requested: 0, moved: 0, confirmed: true, skipped: missing, headers };
  }

  let result;
  try {
    result = await session.moveMessages(req.folder, uids, req.destination);
  } catch (err) {
    if (err instanceof MailboxOpenError) return refuse(openFailure(err));
    return refuse(fail(`Failed to delete from "${req.folder}": ${(err as Error).message}`));
  }

  if (result.requested > 0 && result.moved === 0) {
    // A confirmed zero over uids that were present a moment ago is either a
    // genuine refusal or the same race one round trip later. Ask, rather than
    // guess: a move that failed leaves the messages where they were, so if they
    // are gone they were already deleted by someone else.
    let stillThere = uids;
    try {
      stillThere = (await session.resolveUids(req.folder, uids)).headers.map((h) => h.uid);
    } catch {
      // Unreadable folder: keep the pessimistic reading and report the refusal.
    }
    if (stillThere.length === 0) {
      return { ok: true, uids: [], requested: 0, moved: 0, confirmed: true, skipped: [...missing, ...uids], headers: [] };
    }
    return refuse(fail(
      `The server refused the move: 0 of ${result.requested} messages were moved from "${req.folder}" to "${result.destination}". `
      + `${stillThere.length} of them are still in "${req.folder}", so this is a refusal and not mail that had already been deleted. Nothing was deleted.`,
    ));
  }

  return {
    ok: true,
    uids,
    requested: result.requested,
    moved: result.confirmed ? result.moved : null,
    confirmed: result.confirmed,
    skipped: missing,
    headers,
  };
}
