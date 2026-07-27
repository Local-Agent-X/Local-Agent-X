/**
 * Reading model-authored arguments for the email tools.
 *
 * Separate from the tool definitions because both halves of this file are the
 * same single rule, and the verbs C3 adds (move, delete) need it too: at the
 * tool boundary a present-but-unusable argument is an ERROR naming the
 * parameter and the accepted form — it is NEVER treated as absence.
 *
 * The previous reader coerced anything non-string to `""` and every caller then
 * skipped falsy values, so `before: 1785000000000` — epoch milliseconds, a very
 * plausible thing for a model to emit for a date — dropped the entire date
 * window with no error and no note, and `from: ["a@x", "b@x"]` dropped the
 * sender. EVERY such drop widens the match set, only the all-dropped case was
 * caught (by the whole-mailbox refusal), and this match set is the input to a
 * move and a delete one chunk over. A wrong guess is at least visible in the
 * result; a drop leaves no signal at all.
 */
type ArgError = { error: string };
function isArgError(value: unknown): value is ArgError {
  return typeof value === "object" && value !== null && "error" in value;
}

/** The offending value, short enough to sit inside an error message. */
function describeValue(value: unknown): string {
  if (Array.isArray(value)) return "an array";
  if (value === null) return "null";
  if (typeof value === "object") return "an object";
  return `${typeof value} ${JSON.stringify(value)}`;
}

const OMIT = "Omit the parameter entirely to leave it unset — a value that cannot be used is not the same as no filter at all.";

function strArg(args: Record<string, unknown>, field: string): string | ArgError {
  const value = args[field];
  if (value === undefined) return "";
  if (typeof value !== "string") {
    return { error: `\`${field}\` must be a string, but got ${describeValue(value)}. ${OMIT}` };
  }
  const trimmed = value.trim();
  if (!trimmed) return { error: `\`${field}\` was present but empty. ${OMIT}` };
  return trimmed;
}

/** Digits-as-a-string are unambiguous and are read as the number they spell;
 *  anything else — `"ten"`, `2.5`, `0`, `-1` — is refused rather than falling
 *  back to the default, which would silently change the size of the page. */
function intArg(args: Record<string, unknown>, field: string, fallback: number): number | ArgError {
  const value = args[field];
  if (value === undefined) return fallback;
  const n = typeof value === "string" && /^\d+$/.test(value.trim()) ? Number(value.trim()) : value;
  if (typeof n !== "number" || !Number.isInteger(n) || n <= 0) {
    return { error: `\`${field}\` must be a positive whole number, but got ${describeValue(value)}.` };
  }
  return n;
}

/** `"true"`/`"false"` spell themselves; every other value is refused. `"false"`
 *  in particular used to be truthy, so a model asking for ALL messages got only
 *  the unread ones. Absent is reported as `undefined` rather than `false` so a
 *  caller that needs the THREE-way answer — set it true / set it false / leave
 *  it alone — can have it. `flag()` below collapses absent to false for the
 *  search predicates, where "not asked for" and "false" genuinely coincide. */
function boolArg(args: Record<string, unknown>, field: string): boolean | undefined | ArgError {
  const value = args[field];
  if (value === undefined) return undefined;
  if (typeof value === "boolean") return value;
  const spelled = typeof value === "string" ? value.trim().toLowerCase() : "";
  if (spelled === "true" || spelled === "false") return spelled === "true";
  return { error: `\`${field}\` must be true or false, but got ${describeValue(value)}.` };
}

/** One UID, in any of the two forms a model actually emits: the number, or the
 *  digits as a string. Everything else — a float, a negative, `"latest"`, an
 *  object — is refused, because a UID is a server-assigned handle and there is
 *  no such thing as a near-miss: uid 1001 is a different person's mail than
 *  uid 1000, and the verbs reading this list MOVE the message. */
function oneUid(raw: unknown, field: string): number | ArgError {
  const n = typeof raw === "string" && /^\d+$/.test(raw.trim()) ? Number(raw.trim()) : raw;
  if (typeof n !== "number" || !Number.isInteger(n) || n <= 0) {
    return { error: `\`${field}\` must contain positive whole-number message UIDs (as returned by email_read or email_search), but got ${describeValue(raw)}.` };
  }
  return n;
}

/**
 * An explicit UID SET.
 *
 * Accepts an array, a bare number (one uid), or a comma/space separated string
 * — the three shapes models emit for "these messages". Refuses everything else
 * rather than coercing, and refuses a PRESENT-but-empty set outright: an empty
 * uid list reaching a move is a caller that believes it selected something, and
 * `moveMessages` would answer "moved 0" as if that were a successful no-op.
 *
 * Deduplicated and sorted so `requested` counts messages, not mentions — a
 * repeated uid otherwise inflates the number reported back to the user.
 */
function uidsArg(args: Record<string, unknown>, field: string): number[] | ArgError {
  const value = args[field];
  if (value === undefined) return [];
  let items: unknown[];
  if (Array.isArray(value)) items = value;
  else if (typeof value === "number") items = [value];
  else if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed) return { error: `\`${field}\` was present but empty. ${OMIT}` };
    items = trimmed.split(/[\s,]+/);
  } else {
    return { error: `\`${field}\` must be a list of message UIDs, but got ${describeValue(value)}. ${OMIT}` };
  }
  if (items.length === 0) return { error: `\`${field}\` was present but empty. ${OMIT}` };
  const out: number[] = [];
  for (const item of items) {
    const uid = oneUid(item, field);
    if (isArgError(uid)) return uid;
    out.push(uid);
  }
  return [...new Set(out)].sort((a, b) => a - b);
}

/**
 * Reads every argument, keeping the FIRST error so `execute` can bail once
 * instead of repeating a two-line check per parameter. Nothing is read
 * leniently: a reader that errors returns a harmless placeholder purely so the
 * remaining reads can run, and `error` gates the search.
 */
export function argReader(args: Record<string, unknown>) {
  let error: string | null = null;
  const keep = <T>(result: T | ArgError, fallback: T): T => {
    if (!isArgError(result)) return result;
    error ??= result.error;
    return fallback;
  };
  return {
    text: (field: string): string => keep(strArg(args, field), ""),
    count: (field: string, fallback: number): number => keep(intArg(args, field, fallback), fallback),
    flag: (field: string): boolean => keep(boolArg(args, field), undefined) ?? false,
    /** The three-way form: `undefined` means "leave this alone", which is not
     *  the same instruction as "set it to false". email_mark needs the
     *  distinction — marking a message read must not also un-star it. */
    triState: (field: string): boolean | undefined => keep(boolArg(args, field), undefined),
    /** An explicit set of message UIDs. `[]` means none were given. */
    uids: (field: string): number[] => keep(uidsArg(args, field), []),
    /** A date window, refusing the parse rather than searching a window nobody
     *  asked for. Absent stays absent. */
    date: (field: string): Date | undefined => {
      const raw = keep(strArg(args, field), "");
      if (!raw) return undefined;
      const parsed = parseDateInput(raw);
      if (parsed instanceof Date) return parsed;
      error ??= `${field}: ${parsed.error}`;
      return undefined;
    },
    get error(): string | null { return error; },
  };
}

const RELATIVE_UNIT_MS: Record<string, number> = {
  day: 86_400_000,
  week: 7 * 86_400_000,
};

/** `2026-01-31`, or a full ISO timestamp. Shape only — the calendar day is
 *  range-checked separately, because `Date.parse` does not. */
const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})(?:[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?)?$/;
/**
 * `1 year`, `12 months`, `30 days ago`, `last week`, `a year ago`.
 *
 * Prefix, amount, article and suffix are captured separately so the combinations
 * that are not English can be refused: `last month ago` says it twice, and a
 * bare `week` says neither which week nor how many. The article needs real
 * whitespace after it, or `aday` parses as "a day".
 */
const RELATIVE = /^(?:(last|past)\s+)?(?:(\d{1,4})\s*|(an?)\s+)?(day|week|month|year)s?(?:\s+(ago))?$/i;

/**
 * The floor for any window this tool will accept. A window that starts before
 * email existed is the whole mailbox with a date attached — `since: "0001-01-01"`
 * and `since: "500 years"` select everything, silently, which is the same
 * widening the rest of this file exists to prevent. It also catches the
 * arithmetic ends: `9999 years` resolves to the year -007973.
 */
const EARLIEST_WINDOW_MS = Date.UTC(1970, 0, 1);

const MONTH_LENGTHS = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];

/** Does this y-m-d name a day that exists? `Date.parse` range-checks the MONTH
 *  but not the DAY, and rolls 2026-02-30 forward to 2026-03-02 — a window two
 *  days wider than the one that was asked for. Counted arithmetically rather
 *  than via `Date.UTC`, which remaps two-digit years into the 1900s. */
function isRealCalendarDay(year: number, month: number, day: number): boolean {
  if (month < 1 || month > 12 || day < 1) return false;
  const leap = (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
  return day <= (month === 2 && leap ? 29 : MONTH_LENGTHS[month - 1]);
}

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
  const unparseable = {
    error: `Could not understand the date "${raw}". Use an ISO date (2025-07-26), an ISO timestamp, `
      + "or a relative age such as \"30 days\", \"6 months\", \"1 year ago\". "
      + "Dates are not guessed at, because a wrong date window silently selects the wrong mail.",
  };
  const tooOld = {
    error: `The date "${raw}" is before 1970, which is not a real mail window — it selects everything. `
      + "Give a date inside the mailbox's lifetime.",
  };

  const iso = ISO_DATE.exec(input);
  if (iso) {
    if (!isRealCalendarDay(Number(iso[1]), Number(iso[2]), Number(iso[3]))) return unparseable;
    const ms = Date.parse(input.length === 10 ? `${input}T00:00:00Z` : input);
    if (!Number.isFinite(ms)) return unparseable;
    return ms < EARLIEST_WINDOW_MS ? tooOld : new Date(ms);
  }

  const rel = RELATIVE.exec(input);
  if (rel) {
    const [, prefix, digits, article, unitRaw, ago] = rel;
    // "last month ago" says it twice; a bare "week" says neither how many nor
    // which one. Both used to resolve to a silent 1.
    if (prefix && ago) return unparseable;
    if (!prefix && !digits && !article) return unparseable;
    const amount = digits ? Number(digits) : 1;
    // "0 days" is "before now" — the whole mailbox for whatever else was asked.
    if (!Number.isInteger(amount) || amount < 1) return unparseable;
    const unit = unitRaw.toLowerCase();
    const ms = RELATIVE_UNIT_MS[unit];
    const when = ms !== undefined
      ? new Date(now.getTime() - amount * ms)
      : stepBackMonths(now, unit === "year" ? amount * 12 : amount);
    return when.getTime() < EARLIEST_WINDOW_MS ? tooOld : when;
  }
  return unparseable;
}
