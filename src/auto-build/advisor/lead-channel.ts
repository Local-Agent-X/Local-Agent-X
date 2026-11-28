/**
 * What a build has for its lead, held until the lead's own turn takes it.
 *
 * A lead that drives its build calls build_next (orchestrator/build-next-tool.ts),
 * which waits here inside the lead's turn and returns what the build has: a
 * batch that landed, a decision that is waiting, the build's end. The lead
 * reads it, decides, and calls again, so one turn holds the build the way a
 * person leading it would. While a lead is attached like this the engine stops
 * at each batch boundary until the lead calls again (leadCheckpoint).
 *
 * Nothing depends on the lead staying: when its turn ends, a waiting
 * checkpoint is let go, the build goes on by its own rules, and a decision
 * still unanswered is posted into the chat as before (lead-decisions.ts).
 */
import { hasActiveTurn, onTurnRelease } from "../../session/turn-lock.js";

export interface LeadItem {
  kind: "batch" | "decision" | "ended";
  /** What the lead reads. */
  text: string;
  /** A decision's id: withdrawn by it once answered or given up on. */
  id?: string;
  /** Called when the lead's turn ends with this still not taken. */
  undelivered?: () => void;
  /** A batch boundary the engine is stopped at: lets it go on. */
  release?: () => void;
}

interface Channel {
  queue: LeadItem[];
  /** The lead has called build_next in the turn it is still in. */
  attached: boolean;
  /** Wakes the build_next call that is waiting. */
  wake?: () => void;
  /** Where the engine's progress lines go while a call waits. */
  progress?: (line: string) => void;
  /** Batch boundaries the lead has been handed: let go when it calls again. */
  held: Array<() => void>;
}

/** Batch reports kept for a lead that is not reading them. */
const MAX_UNREAD_BATCHES = 10;
/** How long the engine waits at a batch boundary for an attached lead. */
export const LEAD_CHECKPOINT_MS = 10 * 60_000;

const channels = new Map<string, Channel>();

function channelOf(sessionId: string): Channel {
  let ch = channels.get(sessionId);
  if (!ch) channels.set(sessionId, ch = { queue: [], attached: false, held: [] });
  return ch;
}

/** The lead is in a turn in which it has called build_next. */
export function leadIsAttached(sessionId: string): boolean {
  return channels.get(sessionId)?.attached === true;
}

/** Hold `item` for the lead, and wake a call that is waiting for one. */
export function postToLead(sessionId: string, item: LeadItem): void {
  const ch = channelOf(sessionId);
  ch.queue.push(item);
  const batches = ch.queue.filter((i) => i.kind === "batch");
  if (batches.length > MAX_UNREAD_BATCHES) ch.queue.splice(ch.queue.indexOf(batches[0]), 1);
  ch.wake?.();
}

/** Take back a decision the lead has not been handed: it was answered another way, or given up on. */
export function withdrawFromLead(sessionId: string, id: string): void {
  const ch = channels.get(sessionId);
  if (ch) ch.queue = ch.queue.filter((i) => i.id !== id);
}

/** A line of the build's progress, shown on the waiting call. */
export function noteLeadProgress(sessionId: string, line: string): void {
  channels.get(sessionId)?.progress?.(line);
}

/**
 * A batch boundary: hold `text` for the lead, and with a lead attached wait
 * until it calls build_next again, its turn ends, or the wait runs out.
 */
export function leadCheckpoint(sessionId: string, text: string, opts: { signal?: AbortSignal; waitMs?: number } = {}): Promise<void> {
  const ch = channelOf(sessionId);
  if (!ch.attached || opts.signal?.aborted) {
    postToLead(sessionId, { kind: "batch", text });
    return Promise.resolve();
  }
  return new Promise<void>((resolve) => {
    const timer = setTimeout(done, opts.waitMs ?? LEAD_CHECKPOINT_MS);
    function done(): void {
      clearTimeout(timer);
      const at = ch.held.indexOf(done);
      if (at >= 0) ch.held.splice(at, 1);
      resolve();
    }
    opts.signal?.addEventListener("abort", done, { once: true });
    postToLead(sessionId, { kind: "batch", text, release: done });
  });
}

function letGo(ch: Channel): void {
  for (const done of [...ch.held]) done();
}

function detach(ch: Channel): void {
  ch.attached = false;
  letGo(ch);
  for (const item of ch.queue) item.release?.();
  const dropped = ch.queue.filter((i) => i.undelivered);
  ch.queue = ch.queue.filter((i) => !i.undelivered);
  for (const item of dropped) item.undelivered!();
}

export type LeadWaitEnd = "items" | "stopped" | "user-message" | "not-running";

export interface LeadWait {
  signal?: AbortSignal;
  onProgress?: (line: string) => void;
  /** A build this chat leads is still running. */
  stillRunning: () => boolean;
  /** The user has sent the chat a message it has not read. */
  userIsWaiting: () => boolean;
  /** How often the two above are looked at. */
  pollMs?: number;
}

/**
 * build_next's wait: what the build has for the lead, as soon as it has
 * something; or why the wait ended with nothing. Calling it attaches the lead
 * for the rest of its turn and lets a held batch boundary go.
 */
export async function takeForLead(sessionId: string, wait: LeadWait): Promise<{ why: LeadWaitEnd; items: LeadItem[] }> {
  const ch = channelOf(sessionId);
  const inTurn = hasActiveTurn(sessionId);
  if (!ch.attached) {
    ch.attached = true;
    if (inTurn) onTurnRelease(sessionId, () => detach(ch));
  }
  letGo(ch);
  ch.progress = wait.onProgress;
  const onAbort = () => ch.wake?.();
  wait.signal?.addEventListener("abort", onAbort);
  try {
    for (;;) {
      if (ch.queue.length) {
        const items = ch.queue.splice(0);
        for (const item of items) if (item.release) ch.held.push(item.release);
        return { why: "items", items };
      }
      if (wait.signal?.aborted) return { why: "stopped", items: [] };
      if (wait.userIsWaiting()) return { why: "user-message", items: [] };
      if (!wait.stillRunning()) return { why: "not-running", items: [] };
      await new Promise<void>((resolve) => {
        const timer = setTimeout(woken, wait.pollMs ?? 1_000);
        function woken(): void { clearTimeout(timer); ch.wake = undefined; resolve(); }
        ch.wake = woken;
      });
    }
  } finally {
    wait.signal?.removeEventListener("abort", onAbort);
    ch.progress = undefined;
    ch.wake = undefined;
    // Outside a chat turn nothing ends the attachment but the call itself.
    if (!inTurn) detach(ch);
  }
}

/** Tests only. */
export function _resetLeadChannels(): void {
  channels.clear();
}
