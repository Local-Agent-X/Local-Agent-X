/**
 * LLM-confirmed profile dedupe — the durable-save variant of
 * dedupeProfileMarkdown.
 *
 * The sync dedupe applies every contradiction pair the regex sweep flags,
 * which deletes a profile rule on a polarity-regex + token-overlap heuristic.
 * The durable profile-save funnels (end-of-turn write, memory_update_profile,
 * user-field set) route through this variant instead: each flagged pair is
 * vetted by confirmContradictionPair before the losing bullet is deleted.
 *
 *   verdict true  → delete as before (genuine contradiction)
 *   verdict false → keep BOTH bullets (confirmed false pair — THE FIX)
 *   verdict null  → delete as before (LLM unavailable/timeout/disabled —
 *                   fail-open to the regex verdict, the prior behavior)
 *
 * `confirm` is an injectable default param (house pattern, see
 * correction-learning.recordCorrectionMaybe) so tests pin verdicts without
 * the network. A confirmer throw counts as null.
 */

import { dedupeProfileLines, findProfileBulletPairs, applyProfileDrops } from "./personality.js";
import { confirmContradictionPair } from "../classifiers/contradiction-confirm.js";
import { createLogger } from "../logger.js";

const logger = createLogger("memory.contradiction");

export type ConfirmPairFn = (args: { keepText: string; dropText: string }) => Promise<boolean | null>;

export async function dedupeProfileMarkdownConfirmed(
  content: string,
  confirm: ConfirmPairFn = confirmContradictionPair,
): Promise<string> {
  if (!content || !content.trim()) return content;
  const lines = dedupeProfileLines(content);
  const pairs = findProfileBulletPairs(lines);

  const verdicts = await Promise.all(
    pairs.map((p) =>
      confirm({ keepText: lines[p.keep], dropText: lines[p.drop] }).catch(() => null),
    ),
  );
  const confirmed = pairs.filter((p, i) => {
    if (verdicts[i] !== false) return true;
    logger.info(
      `[contradiction] profile: LLM vetoed drop of "${lines[p.drop].trim().slice(0, 80)}" ` +
      `(regex paired it with "${lines[p.keep].trim().slice(0, 80)}", overlap=${p.overlap.toFixed(2)}) — kept both`,
    );
    return false;
  });
  return applyProfileDrops(lines, confirmed).join("\n") + "\n";
}
