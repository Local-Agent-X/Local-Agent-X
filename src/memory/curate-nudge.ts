/**
 * Memory-curate nudge — pressure to make the model use its own memory tools.
 *
 * The architectural premise: we already have memory_save / memory_update_profile
 * / memory_consolidate exposed to the agent. The historical failure mode was
 * that nothing pushed the model to actually CALL those tools during natural
 * conversation. Without pressure the model treats memory as "passive recall
 * surface" and never writes back what it just learned.
 *
 * This module provides that pressure two ways:
 *
 *   1. Turn cadence — every N turns, inject a one-line system reminder asking
 *      the model to review what it learned and persist anything durable about
 *      the user's preferences or workflows. Default N=10. Configurable via
 *      LAX_MEMORY_NUDGE_INTERVAL.
 *
 *   2. Opportunistic boost — external triggers (regex correction detected,
 *      "remember this" phrases, "next time" / "always do X" patterns, long
 *      task completion) call boostNudgePriority() to advance the per-session
 *      counter so the next prompt fires the nudge regardless of cadence.
 *
 * The nudge text itself is short and tells the model WHAT to write, not what
 * we observed. The model decides what's memory-worthy and how to phrase it
 * generally. That's the whole point of switching from regex-driven verbatim
 * injection to model-driven curation.
 *
 * Cooldown: after a nudge fires, the counter resets to 0. We don't fire two
 * nudges in a row even if a high-priority signal fires immediately after.
 *
 * Cross-provider: the nudge slots into prepare-request.ts alongside the
 * other system-prompt blocks (background completions, short-reply context,
 * cold-start hint), so it applies to every provider — the user's preferences
 * accumulate in USER.md and become visible to whichever model handles the
 * next turn.
 */

import { createLogger } from "../logger.js";

const logger = createLogger("memory.curate-nudge");

// ── Tunables ──

// Cadence default 5 — chosen as the safety net for whatever the LLM
// classifier (curate-classifier.ts) misses, NOT the primary signal. Higher
// values (10) made cadence too slow when classifier was off; lower values
// (3) felt nag-y. 5 = roughly twice per multi-turn task. Override via env.
const DEFAULT_NUDGE_INTERVAL = 5;
const NUDGE_INTERVAL = (() => {
  const env = parseInt(process.env.LAX_MEMORY_NUDGE_INTERVAL || "", 10);
  if (Number.isFinite(env) && env >= 1 && env <= 100) return env;
  return DEFAULT_NUDGE_INTERVAL;
})();

// Boost amounts — how much to advance the counter when an opportunistic
// trigger fires. A boost = NUDGE_INTERVAL means "fire next turn." A boost
// of NUDGE_INTERVAL / 2 means "fire within a few turns." Tune per signal
// strength.
export type NudgeTrigger =
  | "correction-detected"      // user pushed back on something
  | "preference-stated"        // user said "always", "never", "I prefer", etc.
  | "long-task-completed"      // tool-heavy turn just finished
  | "explicit-remember";       // user literally said "remember this"

const TRIGGER_BOOST: Record<NudgeTrigger, number> = {
  "explicit-remember":    NUDGE_INTERVAL,        // fire next turn
  "correction-detected":  NUDGE_INTERVAL,        // fire next turn
  "preference-stated":    Math.ceil(NUDGE_INTERVAL / 2),
  "long-task-completed":  Math.ceil(NUDGE_INTERVAL / 3),
};

// ── Per-session state ──

interface SessionState {
  turnsSinceNudge: number;
  lastNudgeAt: number;     // ms timestamp; 0 = never fired
  pendingTriggers: Set<NudgeTrigger>;
}

const sessions = new Map<string, SessionState>();
// Cap session map to avoid unbounded growth on long-running servers — LRU
// pruning. 1000 sessions * tiny state = fine.
const MAX_SESSIONS = 1000;

function getSession(sessionId: string): SessionState {
  let s = sessions.get(sessionId);
  if (!s) {
    s = { turnsSinceNudge: 0, lastNudgeAt: 0, pendingTriggers: new Set() };
    if (sessions.size >= MAX_SESSIONS) {
      // Drop the oldest entry — Map iteration order is insertion order
      const firstKey = sessions.keys().next().value;
      if (firstKey) sessions.delete(firstKey);
    }
    sessions.set(sessionId, s);
  }
  return s;
}

// ── Public API ──

/**
 * Boost the nudge counter for a session in response to an opportunistic
 * trigger. Called from signal-detection sites (CorrectionLearner,
 * preference-phrase detector, etc.). Idempotent — multiple boosts on the
 * same trigger within the same turn don't compound.
 */
export function boostNudgePriority(sessionId: string, trigger: NudgeTrigger): void {
  if (!sessionId) return;
  const s = getSession(sessionId);
  if (s.pendingTriggers.has(trigger)) return; // idempotent within turn
  s.pendingTriggers.add(trigger);
  s.turnsSinceNudge += TRIGGER_BOOST[trigger];
  logger.info(`[curate-nudge] boost sess=${sessionId.slice(0, 16)} trigger=${trigger} turnsSinceNudge=${s.turnsSinceNudge}`);
}

/**
 * Check if a memory-curate nudge should fire on the upcoming turn for this
 * session. Increments the per-session turn counter as a side effect — call
 * this exactly once per turn from the prompt-build path.
 *
 * Returns the nudge text to inject (or null to skip). When a nudge fires,
 * the per-session counter resets and pending triggers clear.
 */
export function checkAndConsumeNudge(sessionId: string, opts?: {
  /** When true, return the nudge text even if cadence/triggers wouldn't fire.
   *  Used by tests; do not call from production flows. */
  forceFire?: boolean;
}): string | null {
  if (!sessionId) return null;
  const s = getSession(sessionId);
  s.turnsSinceNudge += 1;

  const fire = opts?.forceFire || s.turnsSinceNudge >= NUDGE_INTERVAL;
  if (!fire) return null;

  const triggersThisFiring = Array.from(s.pendingTriggers);
  s.turnsSinceNudge = 0;
  s.lastNudgeAt = Date.now();
  s.pendingTriggers.clear();

  return formatNudge(triggersThisFiring);
}

/**
 * Reset session state — used when a session is closed/reset. Optional;
 * the LRU eviction handles this implicitly for forgotten sessions.
 */
export function resetSession(sessionId: string): void {
  sessions.delete(sessionId);
}

// ── Nudge formatting ──

/**
 * Build the nudge text. Short, imperative, names the right tool, and tells
 * the model HOW to write (compress, replace, don't append-forever).
 *
 * Triggers list isn't shown verbatim — it just biases the framing toward
 * "you might have just learned something" vs "routine review."
 */
function formatNudge(triggers: NudgeTrigger[]): string {
  const opportunistic = triggers.length > 0;

  if (opportunistic) {
    const triggerHints: Record<NudgeTrigger, string> = {
      "explicit-remember":   "user explicitly asked you to remember something",
      "correction-detected": "user pushed back on what you said",
      "preference-stated":   "user stated a preference or workflow rule",
      "long-task-completed": "you just finished a multi-step task",
    };
    const reasons = triggers.map((t) => triggerHints[t]).join("; ");
    return (
      `[memory-curate] Recent signal: ${reasons}. ` +
      `If you learned a durable fact about the user (preference, environment, project, name, decision), ` +
      `call \`remember\` NOW with it as one sentence. ` +
      `For scalar identity fields (Name, Location, Role, Pronouns) use \`memory_set_user_field\`. ` +
      `For narrative profile sections in USER.md use \`memory_update_profile\` with action=replace_section. ` +
      `Phrase generally so it transfers across providers and future tasks. ` +
      `Skip if nothing new — don't write fluff to satisfy the nudge.`
    );
  }

  // Routine cadence-based nudge — softer framing
  return (
    `[memory-curate] Periodic review: think about the last ~10 turns. ` +
    `Did you learn a durable fact, preference, or workflow rule that future sessions should know? ` +
    `If yes, call \`remember\` (facts), \`memory_set_user_field\` (scalar identity), or ` +
    `\`memory_update_profile file='user'\` (narrative profile sections). ` +
    `Phrase generally — these notes are read by every provider on every future turn. ` +
    `If nothing durable was learned, skip — empty nudges are worse than no nudge.`
  );
}

// ── Test/diagnostic exports ──

/** @internal — exposed for tests only. */
export const _internals = {
  NUDGE_INTERVAL,
  TRIGGER_BOOST,
  getSession,
  sessions,
};
