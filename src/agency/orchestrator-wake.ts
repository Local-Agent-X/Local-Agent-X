/**
 * Waking the orchestrator (ADR 0007 §7, its "watch" job). The orchestrator is a
 * chat, and a chat only runs when it gets a message. So when something in its
 * project needs settling, the app sends it one, marked as the app's and not
 * the user's:
 *
 *   - two live agents start changing the same files (claim-clash-gate.ts)
 *   - a merge landed on files another agent changed or is changing
 *     (merge-overlap.ts)
 *   - a worker stopped making progress (canonical-loop/worker-suspension.ts)
 *
 * Events are gathered for WAKE_DELAY_MS so one turn settles several, a repo's
 * orchestrator is woken at most once per MIN_GAP_MS, the same event never
 * wakes it twice, and a turn it is already running is waited out. The turn
 * runs through the chat handler a typed message uses (chat-ws/chat-handler.ts),
 * so it streams to anyone viewing that chat and passes every gate; with nobody
 * attached, a gate that needs a person parks its call in the inbox.
 *
 * The message is composed here from agents' names, tasks and file paths, each
 * on one line and capped: it carries no text an agent chose the shape of.
 */
import { getChatHandler } from "../chat-ws/chat-handler.js";
import { hasActiveTurn, onTurnRelease } from "../session/turn-lock.js";
import { createLogger } from "../logger.js";
import { orchestratorOf } from "./orchestrator-role.js";
import { holdersOfSession, liveHolders } from "./work-claims.js";

const logger = createLogger("agency.orchestrator-wake");

export const WAKE_DELAY_MS = 20_000;
export const MIN_GAP_MS = 2 * 60_000;
const MAX_EVENTS = 8;
const SEEN_CAP = 2_000;

interface Pending { events: string[]; timer: ReturnType<typeof setTimeout> | null }

const pending = new Map<string, Pending>();
const lastWakeAt = new Map<string, number>();
const seen = new Set<string>();
let now: () => number = Date.now;

/** One line, quotes and line breaks out, capped: safe to put in a message. */
export function oneLine(text: string, max = 160): string {
  return text.replace(/[\r\n\t]+/g, " ").replace(/\s+/g, " ").trim().slice(0, max);
}

export function wakeMessage(events: string[]): string {
  return [
    "(Project update for the orchestrator, sent by the app. This is not a message from the user.)",
    ...events.map((e) => `- ${e}`),
    "Settle each by your rules and post what you decided with work_note. If one needs nothing done, say so in a line. Do not start work nobody asked for.",
  ].join("\n");
}

function flush(repoKey: string): void {
  const entry = pending.get(repoKey);
  if (!entry) return;
  entry.timer = null;
  const role = orchestratorOf(repoKey);
  if (!role || entry.events.length === 0) { pending.delete(repoKey); return; }
  // Mid-turn: it will see the project's state in its prompt; tell it the rest after.
  if (hasActiveTurn(role.sessionId)) {
    onTurnRelease(role.sessionId, () => schedule(repoKey, 1_000));
    return;
  }
  const handler = getChatHandler();
  if (!handler) { schedule(repoKey, WAKE_DELAY_MS); return; }
  const events = entry.events.splice(0, MAX_EVENTS);
  if (entry.events.length === 0) pending.delete(repoKey);
  lastWakeAt.set(repoKey, now());
  logger.info(`waking orchestrator ${role.sessionId} with ${events.length} event(s)`);
  void Promise.resolve(handler(role.sessionId, wakeMessage(events), [], { channel: "web" }))
    .catch((e) => logger.warn(`orchestrator wake failed: ${(e as Error).message}`))
    .finally(() => { if (pending.has(repoKey)) schedule(repoKey, WAKE_DELAY_MS); });
}

function schedule(repoKey: string, delayMs: number): void {
  const entry = pending.get(repoKey);
  if (!entry || entry.timer) return;
  const sinceLast = now() - (lastWakeAt.get(repoKey) ?? 0);
  const wait = Math.max(delayMs, MIN_GAP_MS - sinceLast);
  entry.timer = setTimeout(() => flush(repoKey), wait);
  entry.timer.unref?.();
}

/**
 * Something in `repoKey` needs the orchestrator. `key` names the event so it
 * is raised once; `text` is one line of what happened. A repo with no
 * orchestrator ignores it.
 */
export function raiseToOrchestrator(repoKey: string, key: string, text: string): void {
  try {
    if (!orchestratorOf(repoKey)) return;
    const seenKey = `${repoKey}\n${key}`;
    if (seen.has(seenKey)) return;
    if (seen.size >= SEEN_CAP) seen.clear();
    seen.add(seenKey);
    const entry = pending.get(repoKey) ?? { events: [], timer: null };
    entry.events.push(oneLine(text, 400));
    pending.set(repoKey, entry);
    schedule(repoKey, WAKE_DELAY_MS);
  } catch (e) {
    logger.warn(`could not raise to the orchestrator: ${(e as Error).message}`);
  }
}

/** The same, for an event about one agent: raised in each repo it works in. */
export function raiseAboutSession(sessionId: string, key: string, text: (name: string) => string): void {
  for (const h of holdersOfSession(sessionId)) raiseToOrchestrator(h.repoKey, key, text(oneLine(h.displayName, 60)));
}

/** The same, for an event about the agent running op `opId`. */
export function raiseAboutOp(opId: string, key: string, text: (name: string) => string): void {
  try {
    for (const h of liveHolders()) {
      if (h.opId === opId) raiseToOrchestrator(h.repoKey, key, text(oneLine(h.displayName, 60)));
    }
  } catch (e) {
    logger.warn(`could not raise to the orchestrator: ${(e as Error).message}`);
  }
}

/** Two agents are changing the same file: raised once per pair and path,
 *  never for a clash the orchestrator itself is part of. */
export function raiseClash(repoKey: string, writerSessionId: string, otherSessionId: string, otherName: string, path: string, sameFolder: boolean): void {
  const role = orchestratorOf(repoKey);
  if (!role || role.sessionId === writerSessionId || role.sessionId === otherSessionId) return;
  const writer = oneLine(holdersOfSession(writerSessionId).find((h) => h.repoKey === repoKey)?.displayName ?? "Another chat", 60);
  const pair = [writerSessionId, otherSessionId].sort().join("|");
  raiseToOrchestrator(repoKey, `clash|${pair}|${path.toLowerCase()}`,
    `"${writer}" and "${oneLine(otherName, 60)}" are both changing ${oneLine(path, 120)}${sameFolder ? ", in the same folder" : ""}.`);
}

/** Test seams. */
export function _setOrchestratorWakeClockForTest(clock: (() => number) | null): void {
  now = clock ?? Date.now;
}
export function _flushOrchestratorWakeForTest(repoKey: string): void {
  const entry = pending.get(repoKey);
  if (entry?.timer) { clearTimeout(entry.timer); entry.timer = null; }
  flush(repoKey);
}
export function _resetOrchestratorWakeForTest(): void {
  for (const e of pending.values()) if (e.timer) clearTimeout(e.timer);
  pending.clear(); lastWakeAt.clear(); seen.clear(); now = Date.now;
}
