const REFUSAL_AND_ERROR_PATTERNS: RegExp[] = [
  /^(?:I'?m sorry|I apologi[sz]e|Sorry,)\b[^.\n]{0,200}\b(?:can'?t|cannot|unable|won'?t)\b/i,
  /^I (?:can'?t|cannot|am unable to|am not able to)\s+(?:help|assist|complete|provide|do|perform|access|fulfill|generate|produce|continue|comply)/i,
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
const MIN_OUTPUT_LENGTH = 200;
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
  const offTopic = topic.total >= TOPIC_MIN_KEYWORDS && topic.score < TOPIC_MIN_SCORE;
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
