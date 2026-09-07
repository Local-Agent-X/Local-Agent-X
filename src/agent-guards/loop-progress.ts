/**
 * Loop-progress signals — the half of the loop guard that answers "did
 * anything actually change?", split out of loop-detection.ts (which sits at
 * the 400-LOC source-hygiene ceiling and cannot grow). Sibling to
 * post-commit.ts: both extend the ONE LoopState the canonical guard owns
 * rather than keeping parallel per-op state.
 *
 * Three responsibilities, each a measured defect in the guard before this
 * module existed:
 *
 * 1. NOVELTY. The novelty signal was sha1(result.content) verbatim.
 *    Screenshots, DOM snapshots and any result carrying a timing/ref/uuid are
 *    never byte-identical between calls, so `lastTurnHadNovelResult` latched
 *    true forever in any browser-driving op and permanently reset the
 *    discovery + no-progress counters. noveltySignature() strips the spans
 *    that are provably NOT information before hashing, so "the same page
 *    again" reads as the same result.
 *
 * 2. MUTATION PROGRESS. successfulCommittingCallKey() keys on the full
 *    canonicalized arguments, so rewriting ONE scratch file with slightly
 *    different bytes minted a fresh "novel mutation" every lap and zeroed
 *    iterationsSinceProgress. mutationTargetKey() keys on the tool + its
 *    TARGET (path / url), so re-writing the same target is repetition, not
 *    progress, however the content differs.
 *
 * 3. CYCLES. Exact-repeat detection compares a turn against the turn
 *    IMMEDIATELY before it (`key === state.lastToolKey`), so it sees a
 *    stutter but never a circle. A real 110-turn livelock ran the shape
 *    write -> write -> browser -> browser -> http_request twelve times,
 *    renaming its scratch file each lap, and tripped nothing. detectCycle()
 *    looks for a repeating period across a rolling window and — critically —
 *    only reports one when the whole span produced no novel results, so
 *    legitimately repetitive work (edit 12 files, deploy 12 apps) is never
 *    mistaken for a spin.
 *
 * Pure and allocation-bounded: every structure here is capped, and no
 * function throws on malformed tool arguments.
 */
import { createHash } from "node:crypto";

export function parseToolArgs(argsJson: string): Record<string, unknown> | null {
  try {
    const v = JSON.parse(argsJson) as unknown;
    return v && typeof v === "object" && !Array.isArray(v) ? v as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

// -- 1. Novelty signature -------------------------------------------------

/**
 * Spans that differ between two otherwise-identical tool results and carry no
 * information about whether the agent LEARNED anything. Each is a measured
 * cause of the latched-novelty bug, not a speculative one:
 *   - base64 runs: screenshot payloads, inline images.
 *   - snapshot refs: the [1936]-style element handles a fresh DOM snapshot
 *     re-mints on every navigation, and the hex id= markers wrapping external
 *     untrusted content.
 *   - timings: duration_ms=52, "in 52ms".
 *   - uuids and ISO timestamps: request ids, log lines, trace stamps.
 *
 * Byte counts are deliberately NOT normalized — a response changing size IS
 * information, and was the signal that settled a real prod-deploy question.
 */
const VOLATILE_SPANS: Array<[RegExp, string]> = [
  [/[A-Za-z0-9+/]{64,}={0,2}/g, "<b64>"],
  [/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, "<uuid>"],
  [/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z?/g, "<ts>"],
  [/duration_ms\s*=\s*\d+/g, "duration_ms=<n>"],
  [/\bin \d+(?:\.\d+)?ms\b/g, "in <n>ms"],
  [/id="[0-9a-f]{8,}"/gi, "id=<hex>"],
  [/\[\d{2,}\]/g, "[<ref>]"],
  [/\bref\s*=\s*"?\d+"?/g, "ref=<n>"],
];

/**
 * Signature used for "have I seen this result before?". Tool-agnostic by
 * design: the volatile spans above appear across browser, bash and
 * http_request results alike, and a per-tool allow-list would silently miss
 * the next tool that emits a timing.
 */
export function noveltySignature(content: string): string {
  let normalized = content;
  for (const [re, sub] of VOLATILE_SPANS) normalized = normalized.replace(re, sub);
  return createHash("sha1").update(normalized).digest("hex");
}

/**
 * Cap on remembered signatures (~50 bytes each -> ~13 KB at the cap).
 * Comfortably larger than NO_PROGRESS_LIMIT x a few results/turn, so a steady
 * spin's signature stays resident across the whole no-progress window.
 * Shared by every capped Set on LoopState (results, mutation keys, targets).
 */
export const RESULT_SIG_MEMORY = 256;

/**
 * Remember a result signature the op has not seen before.
 *
 * Two records, two audiences. `seenResultSigs` is the bounded FIFO the
 * per-turn detectors read ("have I seen THIS result?"); it evicts its oldest
 * entry at the cap, so its `.size` saturates at RESULT_SIG_MEMORY and says
 * nothing about progress after that. `novelResultsTotal` is the MONOTONIC
 * lifetime count of novel results — never evicted, never reset, never capped —
 * and is the only honest answer to "did the op learn anything since the last
 * checkpoint?" (checkpoint-stop.ts). Comparing `.size` across checkpoints was
 * a measured defect: every long, productive op read as permanently dry past
 * its 256th distinct result.
 */
export function rememberNovelResult(
  state: { seenResultSigs: Set<string>; novelResultsTotal: number },
  signature: string,
): void {
  state.novelResultsTotal++;
  state.seenResultSigs.add(signature);
  if (state.seenResultSigs.size > RESULT_SIG_MEMORY) {
    state.seenResultSigs.delete(state.seenResultSigs.values().next().value!);
  }
}

// -- 2. Mutation target ---------------------------------------------------

/** Argument names that name the THING a mutating call acts on, in priority
 *  order. A call naming none of them has no identifiable target. */
const TARGET_FIELDS = ["path", "file_path", "filePath", "url", "file", "target"];

/**
 * Identity of what a successful mutation actually CHANGED, for the
 * "did we make progress" reset — or NULL when the call names no target
 * this function can identify.
 *
 * Deliberately coarser than successfulCommittingCallKey (which keys on full
 * canonical args and stays the right key for the mutation-REPEAT pivot, where
 * re-issuing a byte-identical call is itself the signal): re-writing the same
 * file with new content is iteration on one artifact, not twelve advances.
 *
 * The null return is load-bearing, not tidiness. Coarsening a call whose
 * target we CANNOT see would collapse genuinely distinct side effects into
 * one identity: 32 email_send calls to 32 different recipients would read as
 * one repeated action and starve the no-progress budget mid-task (the guard
 * suite catches exactly that). Callers MUST fall back to the full-args key
 * on null, which is the behavior every mutating tool had before this
 * function existed. Only calls naming a path or url get the tightened
 * treatment — the entire population of the bug this fixes: rewritten scratch
 * files.
 */
export function mutationTargetKey(call: { name: string; arguments: string }): string | null {
  const args = parseToolArgs(call.arguments);
  if (!args) return null;
  for (const field of TARGET_FIELDS) {
    const v = args[field];
    if (typeof v === "string" && v.length > 0) return `${call.name}\u0000${v}`;
  }
  return null;
}

// -- 3. Cycle detection ---------------------------------------------------

/** Turns of shape history kept. Exceeds MAX_PERIOD x MIN_REPEATS so the
 *  longest detectable cycle still fits with room to spare. */
const CYCLE_WINDOW = 32;
/** Longest cycle we look for. The observed livelock had period 6. */
const MAX_PERIOD = 8;
const MIN_REPEATS = 3;
const MIN_REPEATS_WEAK = 2;

export interface CycleTurn {
  /** Coarse shape of the turn — see turnShapeKey. */
  key: string;
  /** Did this turn surface anything new? A cycle is only reported across a
   *  span where every turn answered no. */
  novel: boolean;
}

/**
 * The shape of a turn for cycle purposes: the tool NAMES in call order,
 * nothing else.
 *
 * Deliberately ignores arguments. The livelock renamed its scratch harness
 * every lap, so any argument-bearing key made each lap look unique —
 * arguments are exactly the axis a stuck agent varies while changing nothing.
 * What stays constant when an agent goes in circles is the PROCEDURE. The
 * novelty gate in detectCycle is what keeps this from firing on legitimate
 * repetitive work.
 */
export function turnShapeKey(toolCalls: Array<{ name: string }>): string {
  return toolCalls.map(tc => tc.name).join(",");
}

/** Append one turn to the rolling window, evicting the oldest. */
export function noteTurnShape(window: CycleTurn[], key: string, novel: boolean): void {
  window.push({ key, novel });
  while (window.length > CYCLE_WINDOW) window.shift();
}

export interface CycleHit {
  period: number;
  repeats: number;
}

/** Interactive wording for a detected cycle. Names the specific evasion —
 *  varying arguments while repeating the procedure — because that is what the
 *  agent is doing when this fires, and a generic "you're looping" reads as
 *  wrong to a model that can see its arguments differ each lap. */
export function cycleNudge(hit: CycleHit): string {
  return `SYSTEM: you've repeated the same ${hit.period}-step procedure ${hit.repeats}x and learned nothing new from it. Varying arguments or renaming files inside the same loop is not progress. Take a genuinely different approach, or tell the user what you've established, what you can't determine from here, and what you'd need from them to get further.`;
}

/** Worker-lane abort note for the same condition. */
export function cycleAbortNote(hit: CycleHit): string {
  return `\n\n(Cycle abort: the same ${hit.period}-step procedure repeated ${hit.repeats}x with no new information.)`;
}

/**
 * Smallest repeating period in the tail of the window, or null.
 *
 * Requires MIN_REPEATS consecutive identical blocks AND zero novel results
 * anywhere in the examined span. Both conditions matter: the repetition is
 * what makes it a loop, and the novelty-free span is what makes it a STUCK
 * loop rather than a productive one. Smallest period wins, so a 2-cycle
 * nested inside a 4-cycle is reported as the tighter spin it is.
 */
export function detectCycle(
  window: CycleTurn[],
  opts?: { modelTier?: "weak" | "medium" | "strong" },
): CycleHit | null {
  const weak = opts?.modelTier === "weak" || opts?.modelTier === "medium";
  const repeats = weak ? MIN_REPEATS_WEAK : MIN_REPEATS;
  for (let period = 2; period <= MAX_PERIOD; period++) {
    const span = period * repeats;
    if (window.length < span) break;
    const tail = window.slice(window.length - span);
    if (tail.some(t => t.novel)) continue;
    // A constant window (one tool name over and over) satisfies every period
    // trivially, and is NOT this detector's job — exact-repeat, redundant-
    // search and discovery-loop each already own that shape with thresholds
    // tuned against real runs. Requiring two distinct shapes inside one period
    // keeps this signal to what it was built for: a multi-step CIRCLE. Without
    // it, a worker doing 6 varied-argument searches aborts where the tuned
    // detectors would have given it to 25.
    if (new Set(tail.slice(0, period).map(t => t.key)).size < 2) continue;
    let matches = true;
    for (let i = period; i < span && matches; i++) {
      if (tail[i].key !== tail[i - period].key) matches = false;
    }
    if (matches) return { period, repeats };
  }
  return null;
}
