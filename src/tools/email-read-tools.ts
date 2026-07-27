import type { ToolDefinition, ToolResult } from "../types.js";
import { getImapConfig } from "./email-config.js";
import {
  fetchBody,
  fetchMessages,
  searchMessages,
  type EmailBody,
  type EmailPage,
  type EmailSearchCriteria,
} from "./email-imap.js";

/** Both read tools need IMAP and nothing else. getImapConfig() returns a STRING
 *  error when IMAP_HOST/USER/PASS aren't all present — that is the existing
 *  notion of "configured", reused rather than duplicated. This is the honest
 *  half of the send/read split: IMAP is optional (C7a), so a send-only mailbox
 *  leaves these two genuinely unusable while email_send still works. */
const imapConfigured = () => typeof getImapConfig() !== "string";

/**
 * Report the page as it came back, truncation included. `count` keeps its
 * previous meaning (messages actually returned); `total` is what the mailbox
 * matched, which the caller could not see before.
 *
 * `content` is ALWAYS the serialized EmailPage and the metadata key set is
 * always the same three keys — including for an empty page. The empty case
 * used to return a plain sentence with two metadata keys, so a caller doing
 * `JSON.parse(result.content)` (the documented contract) threw on exactly the
 * outcome it was least prepared for, and had to sniff which shape it got.
 * `{"messages": [], "total": 0, ...}` reads perfectly well as "nothing here".
 *
 * When the page IS truncated a `note` is prepended — FIRST key, so it is the
 * first thing in the serialized content rather than a boolean buried past a
 * 10-message array. `truncated: true` is already in the payload; a model that
 * scrolled past it and acted on "the 10 emails from that sender" when there are
 * 4,000 is the failure this sentence exists to prevent, because the verbs
 * downstream of this page are a move and a delete. The key is absent (not
 * `null`) when nothing was cut: there is then nothing to say, and callers that
 * compare the whole page shape keep the exact EmailPage they were promised.
 */
function pageResult(page: EmailPage): ToolResult {
  const payload = page.truncated
    ? {
      note: `Showing the ${page.returned} most recent of ${page.total} matching messages. `
        + "Narrow the search or raise `limit` to see the rest — do not treat this page as the full set.",
      ...page,
    }
    : page;
  return {
    content: JSON.stringify(payload, null, 2),
    metadata: { count: page.returned, total: page.total, truncated: page.truncated },
  };
}

function str(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

const RELATIVE_UNIT_MS: Record<string, number> = {
  day: 86_400_000,
  week: 7 * 86_400_000,
};

/** `2026-01-31`, or a full ISO timestamp. */
const ISO_DATE = /^\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?)?$/;
/** `1 year`, `12 months`, `30 days ago`, `last week`, `a year ago`. */
const RELATIVE = /^(?:last\s+|past\s+)?(?:(\d{1,4})|an?)?\s*(day|week|month|year)s?(?:\s+ago)?$/i;

/**
 * Go back whole calendar months, CLAMPING the day to the target month's length.
 *
 * `setUTCMonth(m - 1)` alone overflows: 31 March minus one month is "31
 * February", which JS rolls forward to 3 March — so "before 1 month" would have
 * selected mail from the two days before the call instead of everything older
 * than February. Years go through here as 12 months so 29 February behaves the
 * same way.
 */
function stepBackMonths(from: Date, months: number): Date {
  const day = from.getUTCDate();
  const d = new Date(from.getTime());
  d.setUTCDate(1);
  d.setUTCMonth(d.getUTCMonth() - months);
  const lastDayOfTarget = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
  d.setUTCDate(Math.min(day, lastDayOfTarget));
  return d;
}

/**
 * Turn a model-authored date into a Date, or say why it can't.
 *
 * Deliberately narrow. `new Date(input)` accepts "Message 4" on some runtimes
 * and silently invents a window from "next tuesday"-shaped junk on others, and a
 * silently-wrong window here becomes a silently-wrong DELETE one chunk over
 * (C3 moves what this selects). So exactly two shapes are honoured — an ISO
 * calendar date/timestamp, and a relative "<n> <unit> [ago]" — and everything
 * else is REJECTED with the accepted forms named, so the model can retry with a
 * form we understand instead of acting on a guess.
 *
 * Months and years step the calendar field rather than multiplying an average
 * day count: "before 1 month" on 31 March must mean 28/29 February, not
 * "30 days back", or the window silently misses a month boundary.
 */
export function parseDateInput(raw: string, now = new Date()): Date | { error: string } {
  const input = raw.trim();
  if (ISO_DATE.test(input)) {
    const ms = Date.parse(input.length === 10 ? `${input}T00:00:00Z` : input);
    if (Number.isFinite(ms)) return new Date(ms);
  }
  const rel = RELATIVE.exec(input);
  if (rel) {
    const amount = rel[1] ? Number(rel[1]) : 1;
    const unit = rel[2].toLowerCase();
    const ms = RELATIVE_UNIT_MS[unit];
    if (ms !== undefined) return new Date(now.getTime() - amount * ms);
    return stepBackMonths(now, unit === "year" ? amount * 12 : amount);
  }
  return {
    error: `Could not understand the date "${raw}". Use an ISO date (2025-07-26), an ISO timestamp, `
      + "or a relative age such as \"30 days\", \"6 months\", \"1 year ago\". "
      + "Dates are not guessed at, because a wrong date window silently selects the wrong mail.",
  };
}

/** Read `before`/`since` off the tool arguments into criteria. Returns the
 *  first parse error instead of running a search over a window nobody asked
 *  for. */
function applyDateWindow(args: Record<string, unknown>, criteria: EmailSearchCriteria): string | null {
  for (const field of ["before", "since"] as const) {
    const raw = str(args[field]);
    if (!raw) continue;
    const parsed = parseDateInput(raw);
    if (parsed instanceof Date) criteria[field] = parsed;
    else return `${field}: ${parsed.error}`;
  }
  return null;
}

export const emailRead: ToolDefinition = {
  name: "email_read",
  available: imapConfigured,
  description: "Read the most recent emails from the user's configured IMAP mailbox (email_setup). Returns uid, sender, subject, date, and a body snippet for each message; pass a uid to email_read_message for the full text. Use email_search to filter by sender, subject, or date.",
  parameters: {
    type: "object",
    properties: {
      folder: { type: "string", description: "Mailbox folder (default: INBOX)" },
      limit: { type: "number", description: "Maximum messages to return (default: 10)" },
      unread_only: { type: "boolean", description: "Only return unread messages" },
    },
    required: [],
  },
  async execute(args: Record<string, unknown>): Promise<ToolResult> {
    const cfg = getImapConfig();
    if (typeof cfg === "string") return { content: cfg, isError: true };
    const folder = String(args.folder || "INBOX");
    const limit = Number(args.limit) || 10;
    try {
      const page = args.unread_only
        ? await searchMessages(cfg, folder, { unreadOnly: true }, limit)
        // null, not "*": in IMAP "*" is the LAST message, so this path used to
        // return exactly one message however large `limit` was.
        : await fetchMessages(cfg, folder, null, limit);
      return pageResult(page);
    } catch (err) {
      return { content: `Failed to read emails: ${(err as Error).message}`, isError: true };
    }
  },
};

export const emailSearch: ToolDefinition = {
  name: "email_search",
  available: imapConfigured,
  description: "Search the user's configured IMAP mailbox. Combine any of: free-text `query` (matches subject or sender), `from`, `subject`, `body`, `unread_only`, and a date window (`before` / `since`). All given filters must match. Example — everything from noreply@example.com older than a year: from=\"noreply@example.com\", before=\"1 year\". Returns uid, sender, subject, date and snippet per message plus the true match total.",
  parameters: {
    type: "object",
    properties: {
      query: { type: "string", description: "Free-text: matches subject OR sender" },
      from: { type: "string", description: "Sender address or name contains this" },
      subject: { type: "string", description: "Subject contains this" },
      body: { type: "string", description: "Message body text contains this" },
      unread_only: { type: "boolean", description: "Only unread messages" },
      before: { type: "string", description: "Only messages received before this: ISO date (2025-07-26) or a relative age (\"1 year\", \"30 days\")" },
      since: { type: "string", description: "Only messages received on or after this: ISO date or relative age" },
      folder: { type: "string", description: "Mailbox folder (default: INBOX)" },
      limit: { type: "number", description: "Maximum results (default: 10)" },
    },
    required: [],
  },
  async execute(args: Record<string, unknown>): Promise<ToolResult> {
    const cfg = getImapConfig();
    if (typeof cfg === "string") return { content: cfg, isError: true };
    const folder = String(args.folder || "INBOX");
    const limit = Number(args.limit) || 10;

    const criteria: EmailSearchCriteria = {};
    const from = str(args.from);
    const subject = str(args.subject);
    const body = str(args.body);
    const query = str(args.query);
    if (from) criteria.from = from;
    if (subject) criteria.subject = subject;
    if (body) criteria.body = body;
    if (args.unread_only) criteria.unreadOnly = true;
    // The free-text path every existing caller (and the model's habit) uses:
    // subject OR sender, as one server-side OR. It is an `anyOf` rather than a
    // `text` search so it keeps meaning exactly what it meant before, and it
    // ANDs with the explicit predicates instead of replacing them.
    if (query) criteria.anyOf = [{ subject: query }, { from: query }];
    const dateError = applyDateWindow(args, criteria);
    if (dateError) return { content: `Failed to search emails: ${dateError}`, isError: true };

    try {
      // No predicates reaches searchMessages, which refuses whole-mailbox
      // criteria before it opens a connection. Surfacing ITS error rather than
      // pre-empting with a local one keeps a single statement of that rule.
      const page = await searchMessages(cfg, folder, criteria, limit);
      return pageResult(page);
    } catch (err) {
      return { content: `Failed to search emails: ${(err as Error).message}`, isError: true };
    }
  },
};

/**
 * Reading ONE message in full.
 *
 * A separate tool rather than a `uid` parameter on email_read, deliberately. A
 * tool whose result is sometimes a list of snippets and sometimes one full body
 * has no stable shape for the model to plan against: the natural misuse is
 * calling email_read with a uid and a limit and believing the limit did
 * something, or parsing the list shape and finding a body. Two tools make the
 * choice explicit at call time — "which messages" vs "this message" — and make
 * the uid required, which is also the thing that teaches the model that uids
 * are the handle for the later verbs (move, flag, delete).
 *
 * `available` matches the other two: the whole tool is IMAP.
 */
export const emailReadMessage: ToolDefinition = {
  name: "email_read_message",
  available: imapConfigured,
  description: "Read one email in full from the user's configured IMAP mailbox. Takes the `uid` of a message returned by email_read or email_search and returns its readable body text plus attachment metadata (filename, type, size). Attachment contents are not downloaded.",
  parameters: {
    type: "object",
    properties: {
      uid: { type: "number", description: "UID of the message, as returned by email_read or email_search" },
      folder: { type: "string", description: "Mailbox folder the uid belongs to (default: INBOX)" },
    },
    required: ["uid"],
  },
  async execute(args: Record<string, unknown>): Promise<ToolResult> {
    const cfg = getImapConfig();
    if (typeof cfg === "string") return { content: cfg, isError: true };
    const uid = Number(args.uid);
    // UIDs are per-folder, so a uid without its folder is meaningless — but
    // INBOX is the folder every list defaults to, so defaulting matches where
    // the uid most likely came from.
    const folder = String(args.folder || "INBOX");
    if (!Number.isInteger(uid) || uid <= 0) {
      return {
        content: "email_read_message needs a numeric `uid` from email_read or email_search. "
          + "UIDs identify a message within one folder; list the folder first if you do not have one.",
        isError: true,
      };
    }
    try {
      const message: EmailBody = await fetchBody(cfg, folder, uid);
      const payload = message.truncated
        ? { note: "This body was cut at the size limit — the message continues beyond the text below.", ...message }
        : message;
      return {
        content: JSON.stringify(payload, null, 2),
        metadata: {
          uid: message.uid,
          truncated: message.truncated,
          attachments: message.attachments.length,
        },
      };
    } catch (err) {
      return { content: `Failed to read message: ${(err as Error).message}`, isError: true };
    }
  },
};
