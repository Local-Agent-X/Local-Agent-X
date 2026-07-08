/**
 * End-of-turn extraction coalescer — the single production gateway to
 * runEndOfTurnMemoryWrite (end-of-turn-write.ts).
 *
 * Why a coalescer: the end-of-turn pass costs an LLM call and can outlive the
 * turn that spawned it. Firing one per turn unconditionally would (a) stack
 * concurrent classifier calls per session and (b) burn money on routine
 * turns. This module enforces three invariants per session:
 *
 *   1. Trigger gate — only turns whose session accumulated a curate signal
 *      (opportunistic boost or fired cadence nudge; see curate-nudge.ts)
 *      enqueue at all. This is the cost control the end-of-turn-write.ts
 *      header documents: no signal, no LLM call.
 *   2. Stash-one-trailing — at most one run in flight per session. A request
 *      arriving mid-run overwrites the single pending slot (latest wins);
 *      when the run finishes, exactly one trailing run processes the delta.
 *   3. Mutual exclusion with the main agent — before running, ask the
 *      write-clock (write-safely.ts) whether a "tool"-source memory write
 *      landed since this session's cursor. If yes, the agent already curated
 *      memory itself: skip and advance the cursor. The cursor advances on
 *      success or skip, never on a throwing run (next request retries).
 *
 * State is in-memory only — the cursor does not survive a process restart.
 * Worst case after restart is one benign extra or skipped run per session;
 * both self-correct on the next turn. Runs escape the turn lock by design
 * (fire-and-forget after persist), so each unit of work is self-contained:
 * the captured EndOfTurnContext, never live session state.
 *
 * Shutdown: lifecycle.ts awaits drainPendingExtractions() before closing the
 * memory index, bounded by a timeout so a slow LLM call can't hang teardown.
 */

import { createLogger } from "../logger.js";
import { hasCurateSignal } from "./curate-nudge.js";
import { runEndOfTurnMemoryWrite } from "./end-of-turn-write.js";
import type { EndOfTurnContext } from "./end-of-turn-write.js";
import { getLastWriteTick, getMemoryWriteTick } from "./write-safely.js";

const logger = createLogger("memory.extraction-coalescer");

interface SessionExtractionState {
  /** Write-clock tick as of the last successful or skipped run. */
  cursorTick: number;
  inProgress: boolean;
  /** Stash-one-trailing slot — a mid-run request overwrites it, latest wins. */
  pending: EndOfTurnContext | null;
  /** Settles when the current run loop (including the trailing run) ends. */
  chain: Promise<void> | null;
}

const states = new Map<string, SessionExtractionState>();

// Bound the map on long-running servers. Only idle entries are evictable —
// an in-flight or pending session must keep its state until the loop drains.
const MAX_SESSIONS = 500;

function getState(sessionId: string): SessionExtractionState {
  let s = states.get(sessionId);
  if (!s) {
    if (states.size >= MAX_SESSIONS) {
      for (const [key, candidate] of states) {
        if (!candidate.inProgress && candidate.pending === null) {
          states.delete(key);
          break;
        }
      }
    }
    // Cursor starts at the current tick: "since the cursor" means "since this
    // coalescer started tracking the session", not "ever in process history".
    s = { cursorTick: getMemoryWriteTick(), inProgress: false, pending: null, chain: null };
    states.set(sessionId, s);
  }
  return s;
}

/**
 * Enqueue an end-of-turn extraction for this turn. Synchronous fire-and-
 * forget: gating, coalescing, and the eventual LLM call all happen behind
 * this call; it never throws for run-time failures (they are logged).
 */
export function requestEndOfTurnExtraction(ctx: EndOfTurnContext): void {
  if (!ctx.sessionId || !ctx.userMessage || !ctx.assistantReply) return;
  // Trigger gate — cost control. Sessions without a curate signal never
  // reach the LLM. The signal is consumed by the run itself, which resets
  // curate-nudge state (see end-of-turn-write.ts).
  if (!hasCurateSignal(ctx.sessionId)) return;

  const s = getState(ctx.sessionId);
  if (s.inProgress) {
    s.pending = ctx;
    return;
  }
  s.inProgress = true;
  s.chain = runLoop(s, ctx)
    .catch((e) => {
      logger.warn(`[coalescer] run loop failed sess=${ctx.sessionId}: ${(e as Error).message}`);
    })
    .finally(() => {
      s.inProgress = false;
      s.chain = null;
    });
}

async function runLoop(s: SessionExtractionState, first: EndOfTurnContext): Promise<void> {
  let ctx: EndOfTurnContext | null = first;
  while (ctx) {
    await runOne(s, ctx);
    ctx = s.pending;
    s.pending = null;
  }
}

async function runOne(s: SessionExtractionState, ctx: EndOfTurnContext): Promise<void> {
  const tickAtStart = getMemoryWriteTick();
  // Mutual exclusion: a "tool"-source write since the cursor means the main
  // agent already curated memory — don't fight it. Skip AND advance.
  if (getLastWriteTick("tool") > s.cursorTick) {
    s.cursorTick = tickAtStart;
    logger.info(
      `[coalescer] skip sess=${ctx.sessionId} — main agent wrote memory since cursor`,
    );
    return;
  }
  try {
    await runEndOfTurnMemoryWrite(ctx);
    s.cursorTick = tickAtStart;
  } catch (e) {
    // Cursor deliberately NOT advanced — the next request retries the delta.
    logger.warn(
      `[coalescer] extraction failed sess=${ctx.sessionId} (cursor held): ${(e as Error).message}`,
    );
  }
}

/**
 * Wait for in-flight extraction chains (including their trailing runs) to
 * settle, bounded by `timeoutMs`. Never throws and never hangs — shutdown
 * calls this right before closing the memory index.
 */
export async function drainPendingExtractions(timeoutMs = 3000): Promise<void> {
  const chains: Array<Promise<void>> = [];
  for (const s of states.values()) {
    if (s.chain) chains.push(s.chain);
  }
  if (chains.length === 0) return;
  let timer: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      Promise.allSettled(chains).then(() => undefined),
      new Promise<void>((res) => {
        timer = setTimeout(res, timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** @internal — exposed for tests only. */
export const _internals = {
  states,
  getState,
  reset(): void {
    states.clear();
  },
};
