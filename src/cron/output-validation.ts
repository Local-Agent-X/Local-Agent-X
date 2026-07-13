import { classifyYesNo } from "../classifiers/classify-with-llm.js";

const REFUSAL_AND_ERROR_PATTERNS: RegExp[] = [
  /^(?:I'?m sorry|I apologi[sz]e|Sorry,)\b[^.\n]{0,200}\b(?:can'?t|cannot|unable|won'?t)\b/i,
  /^I (?:can'?t|cannot|am unable to|am not able to)\s+(?:help|assist|complete|provide|do|perform|access|fulfill|generate|produce|continue|comply)/i,
  // Soft refusals that don't lead with "I" — added 2026-05-17 audit.
  /^(?:Unfortunately|Regrettably),?\s+I\s+(?:can'?t|cannot|am unable)/i,
  /^I (?:don'?t|do not) have (?:access|the ability|permission|enough)/i,
  /^(?:Unable|Failed|Error)\s+to\s+(?:complete|access|fetch|connect|reach|generate|produce|retrieve|load)/i,
  /^ERROR:\s/i,
  /\brate[_\s-]?limit(?:ed| exceeded| reached)\b/i,
  /\bquota (?:exceeded|reached|limit)\b/i,
  /\b(?:invalid|missing|expired)\s+api[_\s-]?key\b/i,
  /\bauthentication failed\b/i,
];

const META_BAD_PATTERNS: RegExp[] = [
  /^Scheduled[.:]/i,
  /Job ID:\s*cron_/i,
  /^Blocker report completed/i,
  /saved? to .*\.md/i,
  /report saved/i,
  /^(Done|OK|Completed)[.\s]*$/i,
];

const TOPIC_STOPWORDS = new Set([
  'this','that','with','from','have','will','your','their','there','what','when','where','which','would','could','should',
  'about','into','other','than','then','them','they','also','each','more','most','some','such','very','just','like',
  'report','produce','output','write','save','please','scan','trends','trend','daily','every','today',
]);

const SENTENCE_END_CHARS = `.!?)]}"'\``;
// Lowered 200→100 on 2026-05-17. The 200-char floor rejected legitimate
// short status reports (e.g. "API up: 200 OK in 145ms across 3 endpoints,
// no errors in last 24h, queue depth 0/100, all systems nominal" is
// ~120 chars). 100-char floor still rejects empty/garbage/single-word
// outputs without false-positiving on terse-but-complete reports.
const MIN_OUTPUT_LENGTH = 100;
const TRUNCATION_CHECK_MAX_LENGTH = 1500;
const TOPIC_MIN_KEYWORDS = 4;
const TOPIC_MIN_SCORE = 0.3;

export interface RefusalDetection {
  refused: boolean;
  pattern?: string;
}

export function detectRefusalOrError(text: string): RefusalDetection {
  const trimmed = text.trim();
  if (!trimmed) return { refused: false };
  const head = trimmed.slice(0, 600);
  for (const re of REFUSAL_AND_ERROR_PATTERNS) {
    if (re.test(head)) return { refused: true, pattern: re.source };
  }
  return { refused: false };
}

export function extractTopicKeywords(prompt: string): string[] {
  return [...new Set(
    prompt.toLowerCase()
      .replace(/[^a-z0-9\s]/g, ' ')
      .split(/\s+/)
      .filter(w => w.length >= 4 && !TOPIC_STOPWORDS.has(w))
  )].slice(0, 25);
}

export interface TopicMatch { matched: number; total: number; score: number; }

export function scoreTopicMatch(prompt: string, output: string): TopicMatch {
  const kw = extractTopicKeywords(prompt);
  if (kw.length === 0) return { matched: 0, total: 0, score: 1 };
  const lower = output.toLowerCase();
  let matched = 0;
  for (const w of kw) if (lower.includes(w)) matched++;
  return { matched, total: kw.length, score: matched / kw.length };
}

/**
 * Detect whether the output looks like a real, organized report — even if
 * keyword overlap with the prompt is low (synonyms, paraphrase, structured
 * data instead of prose, etc.). Returns true when at least 2 structural
 * signals are present AND the output is substantive length.
 *
 * Added 2026-05-17 as a fallback for the off-topic detector's substring
 * keyword match, which false-rejected legitimate reports that used
 * synonyms — e.g. a prompt asking for "Q3 pricing" and a report using
 * "cost per call" throughout. The cheap keyword check stays as the
 * fast-path for catching obvious refusals/dumps; this is the
 * second-chance signal so a real report with synonym mismatch isn't
 * discarded.
 */
export function looksLikeStructuredReport(text: string): boolean {
  if (text.length < 800) return false;
  let signals = 0;
  // Markdown headers — agent organized into sections
  if (/^#{1,6}\s+\S/m.test(text)) signals++;
  // Multiple paragraphs — separated by blank lines
  if ((text.match(/\n\s*\n/g) || []).length >= 3) signals++;
  // List items — bullets or numbered
  if ((text.match(/^[\s]*([-*+]|\d+\.)\s+\S/gm) || []).length >= 4) signals++;
  // Sentence density — many sentence-terminating punctuation marks suggests prose
  const sentenceTerminators = (text.match(/[.!?](?=\s|$)/g) || []).length;
  if (sentenceTerminators >= 10) signals++;
  return signals >= 2;
}

export function looksTruncated(text: string): boolean {
  const t = text.trimEnd();
  if (!t) return true;
  if (t.length > TRUNCATION_CHECK_MAX_LENGTH) return false;
  const lastLine = (t.split('\n').pop() || '').trim();
  if (/^#{1,6}\s+\S/.test(lastLine)) return false;
  if (/^([-*+]|\d+\.)\s*$/.test(lastLine)) return true;
  if (/^([-*+]|\d+\.)\s+\S/.test(lastLine)) return false;
  if (/^\|.*\|$/.test(lastLine)) return false;
  if (/(\*\*|__|```|~~~)\s*$/.test(lastLine)) return false;
  const lastChar = t[t.length - 1];
  return !SENTENCE_END_CHARS.includes(lastChar);
}

export interface ValidationResult {
  valid: boolean;
  contentValid: boolean;
  reason?: string;
  details?: {
    matchedBad?: string;
    tooShort?: boolean;
    offTopic?: TopicMatch;
    truncated?: boolean;
    refusal?: RefusalDetection;
    badStop?: boolean;
  };
}

export function validateMissionOutput(prompt: string, output: string, stopReason: string): ValidationResult {
  const trimmed = output.trim();
  if (!trimmed) {
    return { valid: false, contentValid: false, reason: `empty output (stop=${stopReason})`, details: { tooShort: true } };
  }
  const badStop = stopReason !== 'end_turn';
  const refusal = detectRefusalOrError(trimmed);
  const matchedBad = META_BAD_PATTERNS.find(re => re.test(trimmed));
  const tooShort = trimmed.length < MIN_OUTPUT_LENGTH;
  const topic = scoreTopicMatch(prompt, trimmed);
  // Off-topic = keyword score too low AND output doesn't look like a real
  // structured report. The second check is the synonym-rescue: if the
  // agent produced a long, structured response with headers/paragraphs/
  // sentence density, trust it even when keyword overlap is low. Refusals
  // and tool-result dumps are already caught by detectRefusalOrError and
  // META_BAD_PATTERNS upstream; this fallback won't smuggle them through.
  const offTopic = topic.total >= TOPIC_MIN_KEYWORDS
    && topic.score < TOPIC_MIN_SCORE
    && !looksLikeStructuredReport(trimmed);
  const truncated = looksTruncated(trimmed);
  const contentValid = !refusal.refused && !matchedBad && !tooShort && !offTopic && !truncated;

  if (!badStop && contentValid) {
    return { valid: true, contentValid: true };
  }

  const reason = !contentValid && refusal.refused ? `refusal/error pattern: ${refusal.pattern} (stop=${stopReason})`
    : !contentValid && matchedBad ? `matched bad pattern: ${matchedBad.source} (stop=${stopReason})`
    : !contentValid && tooShort ? `output too short (${trimmed.length} chars, expected >= ${MIN_OUTPUT_LENGTH}) (stop=${stopReason})`
    : !contentValid && offTopic ? `off-topic (${topic.matched}/${topic.total} prompt keywords matched, score ${(topic.score * 100).toFixed(0)}%) (stop=${stopReason})`
    : !contentValid ? `output looks truncated (stop=${stopReason})`
    : `bad stopReason: ${stopReason}`;

  return {
    valid: false,
    contentValid,
    reason,
    details: {
      matchedBad: matchedBad?.source,
      tooShort,
      offTopic: offTopic ? topic : undefined,
      truncated,
      refusal,
      badStop,
    },
  };
}

const CONFIRM_SYSTEM_PROMPT = `You are auditing a quality gate that wants to REJECT a scheduled AI job's output. The gate uses keyword patterns for refusals and prompt-keyword overlap for topicality, and it over-fires: a report that opens with a caveat ("I couldn't reach one source, but here is the full analysis...") or answers the mission in synonyms is NOT a refusal or off-topic.

Reply YES if the output genuinely fails the mission — it refuses, errors out, or does not address what the mission asked for. Reply NO if the output substantively delivers on the mission despite the gate's match.

Reply with EXACTLY one line starting with YES or NO, followed by a brief reason.`;

export type ConfirmRejectionFn = (args: { prompt: string; output: string; reason: string }) => Promise<boolean | null>;

const DEFAULT_CONFIRM: ConfirmRejectionFn = ({ prompt, output, reason }) =>
  classifyYesNo({
    category: "mission-validate",
    systemPrompt: CONFIRM_SYSTEM_PROMPT,
    userPrompt:
      `MISSION PROMPT:\n"${prompt.slice(0, 800)}"\n\n` +
      `AGENT OUTPUT (may be truncated):\n"${output.slice(0, 2500)}"\n\n` +
      `GATE'S REJECTION REASON: ${reason}\n\n` +
      `Does the output genuinely fail the mission? YES or NO + one-line reason.`,
    // Once per mission completion — latency is irrelevant next to the run
    // itself, but keep a ceiling so a hung provider can't stall the job.
    timeoutMs: 6000,
    envDisableVar: "LAX_LLM_MISSION_VALIDATE",
  });

/**
 * validateMissionOutput with an LLM second opinion on SEMANTIC rejections.
 * The refusal patterns and topic-overlap score are the churn-prone judgments
 * (this file's dated "added after miss" comments are the record); when one of
 * them is the sole reason for rejection, an LLM reads the actual output. A
 * NO verdict overrides the rejection (content accepted; stopReason gating
 * still applies). YES / null / error keeps the regex rejection — fail-open
 * to the deterministic verdict. Structural rejections (empty, too short,
 * truncated, meta-bad) are never second-guessed.
 */
export async function validateMissionOutputConfirmed(
  prompt: string,
  output: string,
  stopReason: string,
  confirm: ConfirmRejectionFn = DEFAULT_CONFIRM,
): Promise<ValidationResult> {
  const v = validateMissionOutput(prompt, output, stopReason);
  if (v.contentValid) return v;
  const d = v.details;
  const semanticOnly =
    !!(d?.refusal?.refused || d?.offTopic) &&
    !d?.tooShort && !d?.matchedBad && !d?.truncated;
  if (!semanticOnly) return v;

  let verdict: boolean | null = null;
  try {
    verdict = await confirm({ prompt, output, reason: v.reason ?? "" });
  } catch {
    verdict = null;
  }
  if (verdict !== false) return v;

  const badStop = stopReason !== "end_turn";
  return {
    valid: !badStop,
    contentValid: true,
    reason: badStop ? `bad stopReason: ${stopReason}` : undefined,
    details: { ...d, badStop },
  };
}
