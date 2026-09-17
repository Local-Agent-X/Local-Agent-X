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
import { classifyJson } from "../classifiers/classify-with-llm.js";
import { createLogger } from "../logger.js";

const logger = createLogger("memory.contradiction");
const compactLogger = createLogger("memory.profile-compact");

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

/**
 * Semantic compaction — the LAST resort before a durable profile write is
 * blocked for being over MAX_PROFILE_CHARS. Structural dedupe
 * (dedupeProfileMarkdownConfirmed) already ran and wasn't enough: what's left
 * is genuinely distinct content that has simply accumulated past the budget
 * (a finished project still sitting under "Current Projects", a superseded
 * preference nothing ever retracted).
 *
 * Fails open to the ORIGINAL content — never a truncation we invent — on any
 * of: LLM unavailable/timeout (classifyJson → null), a reply that isn't valid
 * JSON with a string `content` field, or a reply that still doesn't fit the
 * cap. The caller's existing cap-check runs again on whatever this returns,
 * so an unchanged result simply falls through to the same backstop that
 * existed before this function did.
 */
export type CompactProfileFn = (args: { content: string; capChars: number }) => Promise<string | null>;

const COMPACT_SYSTEM_PROMPT = `You maintain a user's durable profile file, which is injected into every future conversation with their AI agent — every byte costs tokens on every future turn, forever, so it must stay small.

The file has grown past its character budget. Rewrite it to fit, by DROPPING content that has gone stale — a project that reads as finished/abandoned, a preference explicitly superseded elsewhere in the file, redundant phrasing of the same fact. Do NOT drop or reword a distinct durable fact you cannot identify as stale — when in doubt, keep it. Never invent new facts. Preserve the existing markdown structure (headings, "- Field: value" bullets) so it keeps parsing the same way.

Reply with ONLY a JSON object: {"content": "<the rewritten file>"}. If you cannot confidently shrink it without losing a fact that's still live, reply {"content": null}.`;

async function compactProfileWithLLM(args: { content: string; capChars: number }): Promise<string | null> {
  const result = await classifyJson<{ content: string | null }>({
    category: "profile-compact",
    role: "routing",
    systemPrompt: COMPACT_SYSTEM_PROMPT,
    userPrompt: `Cap: ${args.capChars} characters. Current length: ${args.content.length}.\n\n${args.content}`,
    envDisableVar: "LAX_LLM_PROFILE_COMPACT",
    maxResponseChars: Math.max(2000, args.capChars + 500),
    validate: (parsed) => {
      const content = (parsed as { content?: unknown } | null)?.content;
      return typeof content === "string" ? { content } : null;
    },
  });
  return result?.content ?? null;
}

export async function compactProfileIfOverCap(
  content: string,
  capChars: number,
  compact: CompactProfileFn = compactProfileWithLLM,
): Promise<string> {
  if (content.length <= capChars) return content;
  let compacted: string | null;
  try {
    compacted = await compact({ content, capChars });
  } catch (e) {
    compactLogger.warn(`compaction call failed: ${(e as Error).message} — leaving profile unchanged`);
    compacted = null;
  }
  if (!compacted || !compacted.trim() || compacted.length > capChars) {
    return content;
  }
  compactLogger.info(`compacted profile from ${content.length} to ${compacted.length} chars (cap ${capChars})`);
  return compacted;
}
