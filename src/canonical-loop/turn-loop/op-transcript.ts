/**
 * Op transcript rendering — the conversation an op had, as plain text, for the
 * post-turn skill-review fork (campaign chunk E).
 *
 * Split out of record-outcome.ts, which owns "the op ended, should we learn
 * from this?". Turning a committed op into reviewable prose is a separate
 * responsibility with its own budget, truncation and redaction rules, and it
 * was pushing that file past the 400-LOC hygiene ceiling.
 *
 * Three rules run this file, all three learned the hard way:
 *   1. Tool NAMES are useless. A playbook is made of the exact selectors,
 *      paths, field names and URLs that were hard to find, plus what failed
 *      first and what the user corrected — so arguments and salient results
 *      are in, clipped per entry.
 *   2. Redact BEFORE clipping. Both redactors match complete values, so a
 *      secret cut by a clip matches nothing and its head survives.
 *   3. Never cut the tail to fit. The end of a transcript is the correction
 *      and what finally worked; omissions come out of the middle.
 */
import { readOpMessages } from "../store.js";
import { extractTextContent, opMessageRowToChatParam } from "../chat-runner/message-convert.js";
import { redactKnownSecrets } from "../../sanitize.js";
import { redactString } from "../../ops/redactor.js";
import { createLogger } from "../../logger.js";

const logger = createLogger("canonical-loop.turn-loop.op-transcript");

/**
 * Total budget for the rendered transcript handed to the review fork.
 *
 * The transcript is the fork's ONLY per-run cost driver and sits outside the
 * cached prefix by design (D11), so this number is the review's price. 12k
 * chars is ~3k tokens: enough for ~90 rendered lines — a 40-step browser
 * workflow with its arguments, its results, and the user's corrections — while
 * keeping a pathological 30-iteration op from turning into a 200k-token review.
 */
export const TRANSCRIPT_CHAR_CAP = 12_000;
/** Per-entry clips. Sized by what a playbook is made of: a user correction is a
 *  sentence or two, a selector/path/URL argument is short, and a tool result
 *  matters mostly for its head (status, error, the value that was found). */
const MAX_USER_CHARS = 800;
const MAX_PROSE_CHARS = 600;
const MAX_ARGS_CHARS = 400;
const MAX_RESULT_CHARS = 300;
/**
 * Raw characters carried past each entry's clip so the SHAPE CATALOG sees a
 * credential that straddles the clip whole and can remove it.
 *
 * Clipping first and redacting after is a leak: the catalog matches complete
 * tokens, so the head of a key cut by the clip matches nothing and survives —
 * into the transcript, and from there into a protocol body written to
 * git-synced custom.json.
 *
 * This window is DELIBERATELY not what protects registered vault values. It is
 * positional, and whitespace collapse moves a secret relative to it, so any
 * value the catalog cannot shape-match would fall through — see
 * `redactKnownSecrets` in makeEntry, which runs unwindowed for exactly that
 * reason.
 */
const SECRET_WINDOW = 2048;
/**
 * Width of one "[... N entries omitted ...]" line, newline included.
 * The fixed text is 26 chars ("[... " + " entries omitted ...]"), plus up to 7
 * digits, plus the newline — so 34 covers every gap this can ever render.
 */
const OMISSION_MARKER_COST = 34;

interface TranscriptEntry {
  /** The ordered steps and the user's own words — the procedure itself.
   *  Omitting one is a completeness claim and costs a marker; omitting agent
   *  prose or a tool result claims nothing and is silent. */
  procedural: boolean;
  label: string;
  /** Whitespace-collapsed window over the source. Bounded, NOT yet redacted:
   *  redaction is deferred to the entries that survive the fit. */
  flat: string;
  max: number;
  /** Non-empty when content was cut, which is also the signal that this entry
   *  must be redacted before its final clip. */
  hint: string;
  /** Projected rendered length including the newline. Computed without
   *  redaction so the fit can run before any redactor does. */
  cost: number;
}

function makeEntry(procedural: boolean, label: string, raw: string, max: number): TranscriptEntry {
  // Registered vault values are scrubbed from the FULL raw text, unwindowed and
  // before any collapse or clip. This pass must never be positional: whitespace
  // collapse MOVES a secret relative to any window measured on the raw string,
  // and unlike the shape catalog it is the only thing that can catch a
  // hand-registered human passphrase — which has no detectable shape, so a
  // partial match rescues nothing and the fragment IS the secret. Measured
  // before this moved: a 25-char passphrase behind a 2KB whitespace run
  // rendered 18 of its 25 characters. It is a literal split/join (sanitize.ts)
  // that returns immediately when nothing is registered, so it is linear in the
  // text and free on the common path.
  const safe = redactKnownSecrets(raw);
  const window = safe.length > max + SECRET_WINDOW ? safe.slice(0, max + SECRET_WINDOW) : safe;
  const flat = window.replace(/\s+/g, " ").trim();
  const cut = flat.length > max || window.length < safe.length;
  const hint = cut ? `…[+${Math.max(safe.length - max, 1)}ch]` : "";
  return {
    procedural,
    label,
    flat,
    max,
    hint,
    cost: label.length + Math.min(flat.length, max) + hint.length + 1,
  };
}

function renderEntry(e: TranscriptEntry, redact: (s: string) => string): string {
  // Redact BEFORE the clip. Entries that were never cut skip this and ride the
  // single whole-transcript pass instead — that is the cost control that keeps
  // the redactors off every dropped entry.
  if (!e.hint) return e.label + e.flat;
  const safe = redact(e.flat);
  return e.label + (safe.length > e.max ? safe.slice(0, e.max) : safe) + e.hint;
}

/** Indices ordered by distance from the centre, closest first. */
function middleOutOrder(n: number): number[] {
  const mid = (n - 1) / 2;
  return Array.from({ length: n }, (_, i) => i)
    .sort((a, b) => Math.abs(a - mid) - Math.abs(b - mid));
}

function collectTranscriptEntries(opId: string): TranscriptEntry[] {
  const toolNameByCallId = new Map<string, string>();
  const entries: TranscriptEntry[] = [];
  for (const row of readOpMessages(opId)) {
    const msg = opMessageRowToChatParam(row);
    if (!msg) continue;
    if (msg.role === "user") {
      const text = extractTextContent(msg.content).trim();
      if (text) entries.push(makeEntry(true, "[USER] ", text, MAX_USER_CHARS));
    } else if (msg.role === "assistant") {
      const text = extractTextContent(msg.content).trim();
      if (text) entries.push(makeEntry(false, "[AGENT] ", text, MAX_PROSE_CHARS));
      // Shape-tolerant read: the OpenAI tool-call union has churned across SDK
      // versions and this is not a place to chase type breakage.
      const calls = (msg as { tool_calls?: Array<{ id?: string; function?: { name?: string; arguments?: string } }> }).tool_calls ?? [];
      for (const call of calls) {
        const name = call.function?.name;
        if (!name) continue;
        if (call.id) toolNameByCallId.set(call.id, name);
        entries.push(makeEntry(true, `[TOOL] ${name} `, call.function?.arguments ?? "", MAX_ARGS_CHARS));
      }
    } else if (msg.role === "tool") {
      const name = toolNameByCallId.get(msg.tool_call_id) ?? "tool";
      const text = extractTextContent(msg.content).trim();
      entries.push(makeEntry(false, `[RESULT ${name}] `, text || "(empty)", MAX_RESULT_CHARS));
    }
  }
  return entries;
}

/**
 * Render one op's conversation to plain text for the review fork.
 *
 * Reads through `opMessageRowToChatParam`, the canonical row→message adapter
 * (see the SEAL in store.ts); this module is inside canonical-loop, which is
 * where that read is sanctioned. Returns "" when nothing usable can be
 * produced — callers treat that as "skip the review".
 */
export function renderOpTranscript(opId: string, cap = TRANSCRIPT_CHAR_CAP): string {
  const entries = collectTranscriptEntries(opId);
  const redact = (s: string): string => redactString(redactKnownSecrets(s)).redacted;

  // Converge on the cap rather than slicing the tail off: redaction can GROW
  // text (a 7-char registered value becomes "[REDACTED_SECRET]"), and a tail
  // slice would silently discard the END of the procedure — the correction and
  // what finally worked — which is exactly what must survive.
  //
  // The budget is scaled PROPORTIONALLY, not decremented by the overflow:
  // redaction growth is multiplicative in content volume (a transcript dense
  // with short registered values inflates several-fold), and subtracting the
  // overflow drove the budget negative in one step — collapsing exactly those
  // transcripts to "" instead of shrinking them.
  let budget = cap;
  for (let attempt = 0; attempt < 5 && budget > 0; attempt++) {
    const text = redact(fitTranscript(entries, budget, redact));
    if (text.length <= cap) return text;
    budget = Math.floor(budget * (cap / text.length)) - 64;
  }
  // The fit converges by construction (dropping everything leaves one marker),
  // so only pathological redaction growth lands here. Fail closed and say so —
  // a truncated playbook is worse than none.
  logger.warn(`[op-transcript] ${opId} did not converge under ${cap} chars — skipping`);
  return "";
}

/**
 * Drop entries from the MIDDLE outward until the transcript fits, then render.
 *
 * The head carries the preconditions and the setup; the tail carries the
 * correction and what finally worked. Those are the two ends the review prompt
 * asks for, so a long grind in the middle is what gives way.
 */
function fitTranscript(
  entries: TranscriptEntry[],
  cap: number,
  redact: (s: string) => string,
): string {
  let live = entries;
  let total = live.reduce((n, e) => n + e.cost, 0);

  if (total > cap) {
    // Pass 1 — SILENT. Agent prose and tool results carry no completeness
    // claim, so they can vanish without a marker. Dropping them free of marker
    // cost is what lets the budget go to content instead of to bookkeeping.
    const dropped = new Set<number>();
    for (const i of middleOutOrder(live.length)) {
      if (total <= cap) break;
      if (live[i].procedural) continue;
      dropped.add(i);
      total -= live[i].cost;
    }
    if (dropped.size) live = live.filter((_, i) => !dropped.has(i));
  }

  const keep = live.map(() => true);
  if (total > cap && live.length > 0) {
    // Pass 2 — the ordered steps and the user's own words. Omitting these IS a
    // completeness claim, so it renders a marker. `live` is contiguous after
    // pass 1 and middle-out order drops an unbroken interval around the centre,
    // so there is exactly ONE gap and therefore exactly one marker: reserve its
    // width up front rather than tracking runs.
    //
    // What this replaced: budgeting each dropped entry but not the marker it
    // created, while alternating the two categories as passes over the SAME
    // array. Each pass's gap was walled in by the other category's entries, so
    // neither could grow, dropping ADDED markers faster than it removed
    // content, and the convergence loop below shrank the budget to nothing —
    // long ops rendered as "" and never got reviewed at all.
    const budget = cap - OMISSION_MARKER_COST;
    for (const i of middleOutOrder(live.length)) {
      if (total <= budget) break;
      keep[i] = false;
      total -= live[i].cost;
    }
  }

  const out: string[] = [];
  let gap = 0;
  const flush = (): void => {
    if (gap) out.push(`[... ${gap} entries omitted ...]`);
    gap = 0;
  };
  for (let i = 0; i < live.length; i++) {
    if (!keep[i]) { gap++; continue; }
    flush();
    out.push(renderEntry(live[i], redact));
  }
  flush();
  return out.join("\n");
}
