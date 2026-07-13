/**
 * Confirm gate — LLM second-opinion on high-consequence cognitive signals.
 *
 * The cognition detectors behind these signals are keyword/regex heuristics
 * over the user's own message (first-party NL), and their misfires are sharp:
 *   - "contradiction" (priority 9) instructs the agent to call `forget` /
 *     `update_fact` — a wrong verdict retires a REAL user fact. The detector
 *     matches on first-capitalized-token entity + >0.4 keyword overlap.
 *   - "vulnerability" (priority 9) steers the whole turn into sensitive
 *     handling — a false fire on e.g. "this process died" reads as therapy
 *     voice on a debugging question.
 *   - "emotion-shift" (priority 7) asserts a mood change from punctuation/
 *     lexicon scores.
 *
 * This gate runs once per turn in processMessageImpl, AFTER veto/deep-pass
 * (so every producer path is covered) and BEFORE the bleed gate. Only the
 * categories above are checked — they're rare (each is pre-gated by its
 * detector's trigger patterns), so the added LLM cost on a typical turn is
 * zero. Routine "emotion" adaptation hints fire on most messages and carry a
 * soft consequence, so they deliberately stay regex-only.
 *
 * Verdicts: false → drop the signal (confirmed false alarm); true or null
 * (LLM unavailable/timeout/disabled) → keep it — fail-open to the regex
 * verdict, same contract as every other LAX_LLM_* gate.
 */

import type { ModuleSignal, OrchestratorInput } from "./types.js";
import { classifyYesNo } from "../classifiers/classify-with-llm.js";

const GATED_CATEGORIES = new Set(["contradiction", "vulnerability", "emotion-shift"]);

const SYSTEM_PROMPT = `You are auditing an internal alert an AI assistant raised about a user's message. The alert comes from a keyword heuristic that over-fires: words like "died", "lost", "not" trip it in technical or casual contexts where the alert is wrong.

Reply YES if the alert is an accurate reading of the user's message. Reply NO if it is a false alarm — the message does not actually carry the meaning the alert claims (e.g. "the process died" is not grief; "no backend" is not a contradiction of a stored fact; a joke or a quote is not an emotional shift).

Reply with EXACTLY one line starting with YES or NO, followed by a brief reason.`;

export type ConfirmSignalFn = (
  message: string,
  signal: ModuleSignal,
) => Promise<boolean | null>;

const DEFAULT_CONFIRM: ConfirmSignalFn = (message, signal) =>
  classifyYesNo({
    category: "signal-confirm",
    systemPrompt: SYSTEM_PROMPT,
    userPrompt:
      `USER'S MESSAGE:\n"${message.slice(0, 1200)}"\n\n` +
      `INTERNAL ALERT (source: ${signal.source}, category: ${signal.category}):\n` +
      `"${signal.signal.slice(0, 600)}"\n\n` +
      `Is the alert an accurate reading of the message? YES or NO + one-line reason.`,
    // Pre-turn critical path: this runs while the user waits for the reply to
    // start (same stage as the bleed gate's verdict call). Budget it small;
    // timeout keeps the signal.
    timeoutMs: 2500,
    envDisableVar: "LAX_LLM_SIGNAL_CONFIRM",
  });

/**
 * Drop gated-category signals the LLM confirms as false alarms. All confirms
 * run in parallel; any error counts as null (keep). Non-gated signals pass
 * through untouched, order preserved.
 */
export async function confirmSemanticSignals(
  signals: ModuleSignal[],
  input: OrchestratorInput,
  confirm: ConfirmSignalFn = DEFAULT_CONFIRM,
): Promise<{ signals: ModuleSignal[]; dropped: ModuleSignal[] }> {
  const gated = signals.filter((s) => GATED_CATEGORIES.has(s.category));
  if (gated.length === 0) return { signals, dropped: [] };

  const verdicts = await Promise.all(
    gated.map((s) => confirm(input.message, s).catch(() => null)),
  );
  const falseAlarms = new Set(gated.filter((_, i) => verdicts[i] === false));
  if (falseAlarms.size === 0) return { signals, dropped: [] };
  return {
    signals: signals.filter((s) => !falseAlarms.has(s)),
    dropped: [...falseAlarms],
  };
}
