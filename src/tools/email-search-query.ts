/**
 * Criteria -> imapflow SearchObject, and nothing else.
 *
 * Split out of email-imap.ts because it is the one piece of that module with
 * no connection in it: a pure compiler, testable and importable without a
 * server. email-imap.ts re-exports everything here, so the seam callers use is
 * unchanged.
 */
import type { SearchObject } from "imapflow";

/**
 * Search predicates, mapped onto imapflow's criteria object rather than
 * hand-rolled IMAP search strings. Fields combine with AND; `anyOf` expresses
 * OR. "everything from noreply@x older than a year" is
 * `{ from: "noreply@x", before: <date> }`.
 */
export interface EmailSearchCriteria {
  from?: string;
  subject?: string;
  /** Matches the message body text. */
  body?: string;
  /** Matches anywhere in headers or body. */
  text?: string;
  unreadOnly?: boolean;
  /** Received strictly before this date. */
  before?: Date;
  /** Received on or after this date. */
  since?: Date;
  /** At least one of these must match. Combines with the AND fields above. */
  anyOf?: EmailSearchCriteria[];
}

/**
 * `buildSearchQuery` refused to compile criteria — because they reduce to the
 * whole mailbox, or nest past the depth limit.
 *
 * A TYPE, not a phrase, because the callers downstream are a move and a delete
 * and they have to tell this apart from every other failure. The mutate tools
 * used to classify errors by testing the message with /mailbox|folder|select/i;
 * the empty-criteria refusal below contains the word "mailbox", so a delete
 * with no filters was rewritten into "you picked a \Noselect container, retry
 * against another folder" — a false diagnosis whose suggested repair is wrong.
 * Thrown as itself, it can be surfaced as itself.
 */
export class SearchCriteriaError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SearchCriteriaError";
  }
}

const ANY_OF_MAX_DEPTH = 4;

/**
 * Compile criteria into an imapflow search object.
 *
 * THROWS rather than widening. Criteria that reduce to nothing — `{}`,
 * `anyOf: []`, `anyOf: [{}]`, or nesting past `ANY_OF_MAX_DEPTH` — used to
 * become `{ all: true }`, and inside an `or` branch a single `all: true`
 * alternative makes the WHOLE disjunction match every message in the mailbox.
 * A caller that computes criteria from user input and gets none is not asking
 * for the whole mailbox; the verbs downstream of this are a move and a delete,
 * so the empty case has to fail where it happens rather than at the target.
 * "Everything recent" has an honest expression already: `fetchMessages` with a
 * null uid set.
 */
export function buildSearchQuery(criteria: EmailSearchCriteria, depth = 0): SearchObject {
  const query: SearchObject = {};
  if (criteria.from) query.from = criteria.from;
  if (criteria.subject) query.subject = criteria.subject;
  if (criteria.body) query.body = criteria.body;
  if (criteria.text) query.text = criteria.text;
  if (criteria.unreadOnly) query.seen = false;
  if (criteria.before) query.before = criteria.before;
  if (criteria.since) query.since = criteria.since;
  const alternatives = criteria.anyOf?.filter((c) => c && Object.keys(c).length > 0) ?? [];
  if (alternatives.length > 0) {
    if (depth >= ANY_OF_MAX_DEPTH) {
      throw new SearchCriteriaError(`Search criteria nest anyOf deeper than ${ANY_OF_MAX_DEPTH} levels; flatten them rather than searching a wider set than was asked for.`);
    }
    // Always an `or`, even for one alternative: assigning the single
    // alternative's keys onto `query` overwrote same-named AND siblings, so
    // `{ from: alice, anyOf: [{ from: bob }] }` searched for bob alone. A
    // one-element `or` is walked inline by imapflow's compiler, which is
    // exactly the AND the documented contract promises.
    query.or = alternatives.map((c) => buildSearchQuery(c, depth + 1));
  }
  if (Object.keys(query).length === 0) {
    throw new SearchCriteriaError("Empty search criteria: refusing to build a query that matches the entire mailbox. Pass at least one predicate, or use fetchMessages for the most recent messages.");
  }
  return query;
}
