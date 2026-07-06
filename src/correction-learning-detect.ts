/**
 * Correction Learning — pure detection/extraction helpers.
 *
 * NLP-only: the correction pre-gate, contrast/phrase DETECTION_RULES, topic
 * extraction and date formatting. No store I/O and no dependency on the
 * CorrectionLearner class — re-imported by correction-learning.ts.
 */

// Cheap surface markers that a message might be correcting the agent. This is a
// broad pre-gate; detectCorrection() does the precise extraction via DETECTION_RULES.
// Word-boundary anchored: the old substring test on "no" matched "know", "note",
// "nothing" etc. and fired on nearly every message, forcing a wasted deep-pass
// per turn. Bare "not" only counts in a contrast shape ("not X, Y" / "not X but
// Y") that the rules below can actually extract from.
export const CORRECTION_PREGATE = new RegExp(
  [
    "\\bno\\b", "\\bnope\\b", "\\bnah\\b", "\\bwrong\\b", "\\bincorrect\\b",
    "\\bactually\\b", "\\bnot what\\b", "\\bthat['’]?s not\\b", "\\bthat['’]?s wrong\\b",
    "\\bi meant?\\b", "\\bi (?:already )?(?:said|told you)\\b", "\\byou misunderstood\\b",
    "\\bfix this\\b", "\\byou got it wrong\\b",
    "\\bnot\\s+[^,.!?]{1,80}(?:,|\\bbut\\b)",
  ].join("|"),
  "i",
);

// ── Detection patterns ──────────────────────────────────────

interface DetectionRule {
  pattern: RegExp;
  extract: (match: RegExpMatchArray, userMsg: string, agentMsg: string) => {
    wrongInfo: string;
    correctInfo: string;
    confidence: number;
  } | null;
}

// Hedge openers: "not sure, let us check the logs" is prose, not a correction.
const HEDGE_FRAGMENT = /^(?:sure|certain|really|quite|exactly|necessarily|yet|only|just|ideal|great|good|bad)\b/i;

const FRAGMENT_STOPWORDS = new Set([
  "the", "a", "an", "that", "this", "these", "those", "it", "its", "is", "was",
  "are", "were", "be", "being", "been", "to", "of", "in", "on", "at", "for",
  "with", "and", "or", "but", "not", "you", "your", "i", "we", "they", "what",
  "which", "one", "thing",
]);

/**
 * A contrast phrase ("not X, Y" / "not X but Y") only counts as a correction
 * when X refers to something the agent actually said — otherwise the pattern
 * matches ordinary prose ("not sure, let us check the logs") and pollutes the
 * store. Requires at least one substantive token of X to appear in the
 * previous agent message.
 */
function contrastExtract(
  match: RegExpMatchArray,
  agentMsg: string,
): { wrongInfo: string; correctInfo: string; confidence: number } | null {
  const fragment = match[1].replace(/[.!]+$/, "").trim();
  if (HEDGE_FRAGMENT.test(fragment)) return null;
  const agent = agentMsg.toLowerCase();
  if (!agent) return null;
  const tokens = fragment
    .toLowerCase()
    .split(/[^a-z0-9_-]+/)
    .filter(t => t.length >= 3 && !FRAGMENT_STOPWORDS.has(t));
  if (tokens.length === 0 || !tokens.some(t => agent.includes(t))) return null;
  return {
    wrongInfo: fragment,
    correctInfo: match[2].replace(/[.!]+$/, "").trim(),
    confidence: 0.75,
  };
}

export const DETECTION_RULES: DetectionRule[] = [
  // "no, it's X" / "no it's X"
  {
    pattern: /\bno[,.]?\s+it(?:'|')?s\s+(.+)/i,
    extract: (match, _user, agent) => ({
      wrongInfo: agent.slice(0, 200),
      correctInfo: match[1].replace(/[.!]+$/, "").trim(),
      confidence: 0.8,
    }),
  },
  // "not X, Y" / "not X but Y"
  {
    pattern: /\bnot\s+(.+?)[,]\s*(?:but\s+)?(.+)/i,
    extract: (match, _user, agent) => contrastExtract(match, agent),
  },
  // "not X but Y" (without comma)
  {
    pattern: /\bnot\s+(.+?)\s+but\s+(.+)/i,
    extract: (match, _user, agent) => contrastExtract(match, agent),
  },
  // "I told you X" / "I already said X" / "I already told you X"
  {
    pattern: /\bi\s+(?:already\s+)?(?:told\s+you|said)\s+(.+)/i,
    extract: (match, _user, agent) => ({
      wrongInfo: agent.slice(0, 200),
      correctInfo: match[1].replace(/[.!]+$/, "").trim(),
      confidence: 0.85,
    }),
  },
  // "I meant X" / "I mean X"
  {
    pattern: /\bi\s+mean[t]?\s+(.+)/i,
    extract: (match, _user, agent) => ({
      wrongInfo: agent.slice(0, 200),
      correctInfo: match[1].replace(/[.!]+$/, "").trim(),
      confidence: 0.6,
    }),
  },
  // "wrong" / "incorrect" / "that's not right" / "that's wrong"
  {
    pattern: /\b(?:wrong|incorrect|that(?:'|')?s\s+not\s+right|that(?:'|')?s\s+wrong)\b/i,
    extract: (_match, user, agent) => ({
      wrongInfo: agent.slice(0, 200),
      correctInfo: user.replace(/\b(?:wrong|incorrect|that(?:'|')?s\s+not\s+right|that(?:'|')?s\s+wrong)\b/i, "").trim(),
      confidence: 0.5,
    }),
  },
  // "no" at start of message (simple disagreement)
  {
    pattern: /^no[.,!]?\s+(.+)/i,
    extract: (match, _user, agent) => ({
      wrongInfo: agent.slice(0, 200),
      correctInfo: match[1].replace(/[.!]+$/, "").trim(),
      confidence: 0.55,
    }),
  },
];

// ── Helpers ─────────────────────────────────────────────────

export function extractTopics(text: string): string[] {
  // Pull out notable words (capitalized, technical terms, etc.)
  const words = text.split(/\s+/);
  const topics: string[] = [];
  for (const w of words) {
    const clean = w.replace(/[^a-zA-Z0-9_-]/g, "");
    if (clean.length > 3 && clean[0] === clean[0].toUpperCase() && clean[0] !== clean[0].toLowerCase()) {
      topics.push(clean.toLowerCase());
    }
  }
  // Also grab quoted strings
  const quoted = text.match(/["'`]([^"'`]+)["'`]/g);
  if (quoted) {
    for (const q of quoted) {
      topics.push(q.replace(/["'`]/g, "").toLowerCase());
    }
  }
  return [...new Set(topics)];
}

export function formatDate(ts: number): string {
  return new Date(ts).toISOString().split("T")[0];
}
