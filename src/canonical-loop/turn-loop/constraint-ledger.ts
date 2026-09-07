/**
 * Standing-constraint ledger — the op's memory of refusals it has already met.
 *
 * The failure this closes: a gate that rejects deterministically was
 * rediscovered over and over inside one op. A real 160-turn run hit the same
 * write-gate rejection ("html missing <meta name=viewport>") FOURTEEN times,
 * each costing a full turn plus an injected failure nudge, because nothing
 * carried "you already learned this" from one turn to the next. The generic
 * per-turn nudge ("a tool call returned a non-ok status, retry or report") is
 * exactly the wrong instruction for a refusal that will never succeed on
 * retry, and it was the only thing the loop said.
 *
 * WHY THIS IS DERIVED, NOT A PATTERN LIST. The obvious implementation is a
 * table of known gate messages. That table is a thirteenth hand-maintained
 * list to rot: it can only ever recognize the refusals someone remembered to
 * add, and the next gate ships without an entry. Instead a constraint is
 * defined by EVIDENCE — the same tool refusing with the same normalized reason
 * twice in one op is deterministic by observation. No gate needs to know this
 * module exists, and a gate added tomorrow is covered on the day it ships.
 *
 * The ledger only ever ADDS a line to the failure nudge that already fires; it
 * never suppresses a retry or blocks a call. Being wrong here costs a sentence
 * of context, not a capability.
 */

/** Repeats of one normalized reason before it counts as a standing constraint.
 *  Two, because the second identical refusal is the first evidence that
 *  retrying is not a strategy — and the point is to catch it early, not to
 *  confirm it a dozen times the way the recorded run did. */
const CONSTRAINT_THRESHOLD = 2;

/** Cap on distinct constraints remembered per op — a bound on a Map that a
 *  pathological op could otherwise grow without limit. */
const MAX_CONSTRAINTS = 64;

/** Reason text longer than this is truncated in the reminder so one verbose
 *  gate message cannot crowd out the turn's actual content. */
const MAX_REASON_CHARS = 160;

export interface ConstraintLedger {
  /** normalized key → { count, the first verbatim reason seen, tool } */
  seen: Map<string, { count: number; reason: string; tool: string }>;
}

export function createConstraintLedger(): ConstraintLedger {
  return { seen: new Map() };
}

/**
 * Collapse the incidental parts of a refusal so two instances of the SAME gate
 * match even though they name different files.
 *
 * The recorded run renamed its scratch harness every lap (`_mt.html`,
 * `_prod.html`, `_h.html`), so a raw-string key would have recorded fourteen
 * distinct "constraints" and recognized none of them. Quoted spans, path-like
 * runs, and digits are the parts that varied; the gate's own sentence is what
 * stayed constant.
 */
export function normalizeReason(reason: string): string {
  return reason
    .toLowerCase()
    .replace(/["'`][^"'`]*["'`]/g, "<q>")           // quoted values
    .replace(/[a-z]:[\\/][^\s,;)]+/g, "<path>")      // windows absolute paths
    .replace(/(?:[\w.-]*[\\/])+[\w.-]+/g, "<path>")  // any other path-like run
    .replace(/\d+/g, "<n>")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Record this turn's failures. Returns the constraints that have now crossed
 * the threshold, so the caller can remind the model exactly once per turn.
 */
export function noteFailures(
  ledger: ConstraintLedger,
  failures: Array<{ tool: string; reason: string; declined?: boolean }>,
): Array<{ tool: string; reason: string; count: number }> {
  const crossed: Array<{ tool: string; reason: string; count: number }> = [];
  for (const failure of failures) {
    // A user decline is NOT a standing constraint: the same call may be
    // approved next time, and telling the model "this is deterministic, stop
    // trying" would be false — the user, not the system, said no.
    if (failure.declined) continue;
    if (!failure.reason?.trim()) continue;
    const key = `${failure.tool}\u0000${normalizeReason(failure.reason)}`;
    const entry = ledger.seen.get(key);
    if (entry) {
      entry.count += 1;
      if (entry.count >= CONSTRAINT_THRESHOLD) {
        crossed.push({ tool: entry.tool, reason: entry.reason, count: entry.count });
      }
      continue;
    }
    if (ledger.seen.size >= MAX_CONSTRAINTS) continue;
    ledger.seen.set(key, { count: 1, reason: failure.reason.trim(), tool: failure.tool });
  }
  return crossed;
}

/**
 * The reminder appended to the failure nudge. Deliberately says the one thing
 * the generic nudge cannot: retrying is not a strategy here.
 */
export function formatConstraintReminder(
  crossed: Array<{ tool: string; reason: string; count: number }>,
): string {
  if (crossed.length === 0) return "";
  const lines = [
    "",
    "Standing constraints — you have hit these before in this task, so they are deterministic, not flaky. Retrying an identical call will fail identically. Satisfy the constraint, take a different route, or tell the user it blocks you:",
  ];
  for (const c of crossed) {
    const reason = c.reason.length > MAX_REASON_CHARS
      ? `${c.reason.slice(0, MAX_REASON_CHARS)}…`
      : c.reason;
    lines.push(`• ${c.tool} (${c.count}x) — ${reason}`);
  }
  return lines.join("\n");
}
