/**
 * Static injection-pattern / homoglyph / scaffolding catalog for the
 * content-sanitization guard. Pure data, no logic. The detection and scoring
 * engine lives in sanitize.ts and consumes these tables. Split out so the
 * pattern/score catalog can be reviewed in isolation from the engine that
 * applies it; a change here is a security-sensitive change to what gets
 * flagged as prompt injection.
 */

// ── Suspicious patterns (prompt injection indicators) ──

export const INJECTION_PATTERNS: Array<{ pattern: RegExp; score: number; label: string }> = [
  // Direct instruction hijacking
  { pattern: /ignore\s+(all\s+)?previous\s+instructions/i, score: 0.95, label: "instruction-override" },
  { pattern: /forget\s+(everything|all|your|the)/i, score: 0.9, label: "memory-wipe" },
  { pattern: /you\s+are\s+now\s+a/i, score: 0.9, label: "identity-hijack" },
  { pattern: /new\s+instructions?\s*:/i, score: 0.85, label: "new-instructions" },
  // NOTE: the bare "system:" colon form was removed — it false-flagged benign
  // markdown headings ("Scoring System:", "Nervous System:"). A real
  // "System: <do X>" injection is still caught: the imperative payload trips a
  // higher-confidence pattern (identity-hijack / instruction-override) or the
  // weak persistent/always directives accumulate past the cumulative threshold.
  { pattern: /system\s*(prompt|message|override|command)/i, score: 0.85, label: "system-spoof" },
  { pattern: /\[system\s*(message)?\]/i, score: 0.85, label: "system-tag" },
  { pattern: /<\/?system>/i, score: 0.85, label: "system-xml" },
  { pattern: /elevated\s*=\s*true/i, score: 0.8, label: "elevation-flag" },
  { pattern: /admin\s*mode\s*(:|enabled|on|true)/i, score: 0.8, label: "admin-mode" },
  // Tool manipulation
  { pattern: /call\s+the\s+(bash|shell|write|edit)\s+tool/i, score: 0.7, label: "tool-steering" },
  { pattern: /execute\s+(this|the\s+following)\s+command/i, score: 0.65, label: "command-injection" },
  { pattern: /run\s+`[^`]+`/i, score: 0.6, label: "backtick-command" },
  // Exfiltration attempts
  { pattern: /send\s+(this|the|all|my)\s+(data|info|secret|token|key)/i, score: 0.75, label: "exfil-request" },
  { pattern: /curl\s+https?:\/\//i, score: 0.6, label: "exfil-curl" },
  { pattern: /rm\s+-rf/i, score: 0.9, label: "destructive-command" },
  { pattern: /delete\s+all/i, score: 0.65, label: "delete-all" },
  // ── Fuzzy / synonym variants (bypass resistance) ──
  { pattern: /disregard\s+(all\s+)?(previous|prior|earlier|above)/i, score: 0.95, label: "instruction-override-synonym" },
  { pattern: /override\s+(your|the|all)\s+(instructions?|rules?|guidelines?|constraints?)/i, score: 0.9, label: "override-synonym" },
  { pattern: /pretend\s+(you\s+are|to\s+be|you're)/i, score: 0.85, label: "identity-pretend" },
  { pattern: /act\s+as\s+(if\s+you\s+are|an?\s+)/i, score: 0.8, label: "identity-act-as" },
  { pattern: /imagine\s+you\s+(are|have|were|can)/i, score: 0.75, label: "identity-imagine" },
  { pattern: /do\s+not\s+follow\s+(your|the|any)\s+(rules?|instructions?|guidelines?)/i, score: 0.9, label: "rule-bypass" },
  { pattern: /jailbreak/i, score: 0.95, label: "jailbreak-keyword" },
  { pattern: /\bDAN\b\s*(mode|prompt)?/i, score: 0.9, label: "dan-jailbreak" },
  { pattern: /developer\s+mode\s*(:|enabled|on|true|output)/i, score: 0.85, label: "dev-mode-inject" },
  { pattern: /\bplease\s+ignore\s+(the|your|all|any)\s+(safety|security|guard|filter)/i, score: 0.9, label: "safety-bypass" },
  { pattern: /output\s+(your|the)\s+(system|initial|original)\s+(prompt|instructions?|message)/i, score: 0.85, label: "prompt-leak" },
  { pattern: /what\s+(is|are)\s+your\s+(system|initial|original)\s+(prompt|instructions?)/i, score: 0.7, label: "prompt-probe" },
  { pattern: /repeat\s+(the\s+)?(text|words?|content)\s+(above|before|prior)/i, score: 0.8, label: "context-extract" },
  // ── Semantic injection (intent-based, not just keyword) ──
  { pattern: /\b(secretly|covertly|without\s+(the\s+)?user\s+knowing)\b/i, score: 0.85, label: "covert-action" },
  { pattern: /\b(hide|conceal|obscure)\s+(this|the|your)\s+(action|output|response)/i, score: 0.8, label: "stealth-action" },
  { pattern: /\bdo\s+not\s+(tell|inform|alert|notify)\s+(the\s+)?user/i, score: 0.9, label: "hide-from-user" },
  { pattern: /\b(before|after)\s+responding.*\b(also|first|quietly)\b/i, score: 0.7, label: "side-channel" },
  { pattern: /\binsert\s+(into|in)\s+(the|your)\s+(response|output|reply).*\b(hidden|invisible)\b/i, score: 0.85, label: "hidden-payload" },
  { pattern: /\bencode\s+(the|this|your|all)\s+(response|output|data)\s+(in|as|to)\s+(base64|hex|rot13)/i, score: 0.9, label: "encoding-exfil" },
  // ── Obfuscated injection (CL4R1T4S-class: leetspeak directive + glyph pseudo-tag) ──
  // own-instructions-leak requires BOTH a leak verb AND a verbatim qualifier
  // around a possessive reference to the model's own instructions/prompt —
  // "<output/reveal/include…> your <own/full/system…> <instructions/prompt…>
  // <in full/verbatim/word-for-word/in entirety>". Neither half alone separates
  // attack from benign English: a verb-only arm fired on "send me your full
  // instructions for the return process"; a qualifier-only arm fired on "we kept
  // your original instructions in full". Requiring both, in sequence, is the
  // discriminator (an attacker commanding the model to dump its prompt verbatim).
  // "your system prompt" attacks are already covered by system-spoof; this catches
  // the instructions/directives form it misses. inc[il]ud\w* and in\s+fu[li]{2}
  // absorb the lossy '1'→i/l de-leet ("1nc1ud1ng…1n fu11" → "inciuding…in fuii").
  // new-paradigm: the *!<NEW_PARADIGM>!* marker — wrapped in <>/*! so a bare
  // snake_case identifier (new_paradigm = True) doesn't false-fire.
  // pseudo-pipe-glyph: a <|…|> wrapper with a non-ASCII char inside and NO ASCII
  // whitespace (the PLINIVS glyph-header class — a contiguous token, not a prose
  // span). Pure-ASCII <|im_start|> chat-template tokens are NOT scored (quoted
  // legitimately in ML docs); they're neutralized by stripSystemInjectionTags
  // (PSEUDO_PIPE_TAG_RE) on the untrusted-content path instead. Inner | and > are
  // allowed so a one-char mutation can't evade.
  { pattern: /\b(?:inc[il]ud\w*|reveal\w*|disclos\w*|divulg\w*|regurgitat\w*|repeat|output|print|dump|spit\s+out)\b[\s\S]{0,30}\byour\s+(?:own|full|complete|entire|system|initial|original)\s+(?:instruct(?:ions?|s)?|prompts?|directives?|system\s+message)\b[\s\S]{0,25}\b(?:in\s+fu[li]{2}|verbatim|word[\s-]for[\s-]word|in\s+(?:their\s+)?entirety)\b/i, score: 0.7, label: "own-instructions-leak" },
  { pattern: /[<*!]\s*new_paradigm\s*[>*!]/i, score: 0.6, label: "new-paradigm" },
  { pattern: /<\|[^ \t\r\n]{0,400}?[^\x00-\x7F][^ \t\r\n]{0,400}?\|>/, score: 0.6, label: "pseudo-pipe-glyph" },
];

// ── Unicode homoglyph detection ──

// Characters that look like < > but are Unicode variants
export const ANGLE_HOMOGLYPHS = /[\uFF1C\uFE64\u2329\u27E8\u3008\uFF1E\uFE65\u232A\u27E9\u3009\u276C\u276D\u2770\u2771\uFE3B\uFE3C]/g;
// Invisible format characters that can be used to hide text
export const INVISIBLE_CHARS = /[\u200B\u200C\u200D\u200E\u200F\uFEFF\u2060\u2061\u2062\u2063\u2064\u00AD\u034F\u180E]/g;
// Unicode control characters
export const CONTROL_CHARS = /[\x00-\x08\x0B\x0C\x0E-\x1F\x7F-\x9F]/g;

// ── System-tag injection stripping ──
// Tags like <system-reminder>, <system>, <human>, <assistant> embedded in
// tool results (e.g. from a malicious web page or evaluate() call) are
// interpreted as real protocol frames by some models (Anthropic in particular).
// Strip the whole block — tag + content — before it reaches the model.

const SYSTEM_INJECTION_TAG_NAMES = [
  "system-reminder", "system", "human", "assistant", "user", "admin", "operator",
];
export const SYSTEM_INJECTION_TAG_RE = new RegExp(
  `<(${SYSTEM_INJECTION_TAG_NAMES.join("|")})(\\s[^>]*)?>([\\s\\S]*?)<\\/(${SYSTEM_INJECTION_TAG_NAMES.join("|")})>`,
  "gi"
);
// Also strip lone opening/closing tags (no content) — e.g. </system> alone
export const SYSTEM_INJECTION_LONE_TAG_RE = new RegExp(
  `<\\/?( ${SYSTEM_INJECTION_TAG_NAMES.join("|")})(\\s[^>]*)?>`,
  "gi"
);

// ── Pseudo-pipe tag (chat-template / glyph header spoofs) ──
// Tokens like <|im_start|>, <|system|>, or glyph headers (<|…PLINIVS…|>) mimic a
// model's chat-template delimiters. Strip the whole token before the model sees
// it (on the untrusted-content path). Inner | and > are allowed so a one-char
// mutation (::→|) can't evade — that was the original strict-char-class hole.
// The key constraint is NO inner ASCII whitespace: a real delimiter/header is a
// contiguous token, while benign prose with a stray "<|" before a later "|>"
// (type-theory/F#/DSL docs) has spaces between them — so this no longer eats the
// text between two unrelated operators. Bounded at 400 to keep it tight.
export const PSEUDO_PIPE_TAG_RE = /<\|[^ \t\r\n]{1,400}?\|>/g;

// ── Leetspeak normalization map ──
// Powers a SECOND scan view (deleet() in sanitize.ts) so digit-substituted
// directives ("1nc1ud1ng y0ur 0wn 1n57ruc75") match the same patterns plain text
// does. Only ever an extra view — never mutates the canonical text. Excludes 2
// and 6 (ambiguous, high false-substitution rate).
export const LEET_MAP: Record<string, string> = {
  "0": "o", "1": "i", "3": "e", "4": "a", "5": "s", "7": "t", "8": "b", "9": "g", "@": "a", "$": "s",
};

// ── Harness scaffolding stripping ──
// The agent harness injects scaffolding INTO user messages: <system-reminder>
// context blocks and anti-loop / self-check nudges ("SYSTEM: You have called
// read 8 times. Stop searching and produce your final output.", "[Self-check]
// The following tool errors occurred..."). This is NOT user-authored content
// and must never be mined into durable memory. A worker once saved "stop
// searching after 11 instructions" as a fact — it had extracted one of these.
// Anchored, tight regexes only; err toward leaving real prose in over false-
// stripping (a false strip loses a real fact).

export const HARNESS_SCAFFOLD_PATTERNS: RegExp[] = [
  /<system-reminder>[\s\S]*?<\/system-reminder>/gi,
  /^\s*SYSTEM:\s*You have called[\s\S]*?(?:\n\n|$)/gim,
  /you have called \w+ \d+ times[\s\S]*?(?:final output\.?|$)/gi,
  /stop searching and produce your final output\.?/gi,
  /^\s*\[Self-check\][\s\S]*?(?:\n\n|$)/gim,
];

// ── Memory Taint Protection ──
// Prevents untrusted external content from being persisted into
// high-trust memory/profile files, which would create permanent
// instruction hijacks (durable prompt injection).

/** Markers that indicate content originated from an external/untrusted source */
export const EXTERNAL_MARKERS = [
  /<<<EXTERNAL_UNTRUSTED_CONTENT/i,
  /\[MARKER_SANITIZED\]/i,
  /INJECTION WARNING/i,
];

// Weak, memory-specific signals not in INJECTION_PATTERNS. Each is too
// ambiguous to block on its own ("from now on I'll go to the gym" is a benign
// memory) — they only ever contribute to the cumulative score.
export const MEMORY_INJECTION_EXTRA: Array<{ pattern: RegExp; score: number; label: string }> = [
  { pattern: /ALWAYS\s+(do|execute|run|call|send|output)/i, score: 0.2, label: "always-directive" },
  { pattern: /NEVER\s+(tell|mention|reveal|show|say)/i, score: 0.2, label: "never-directive" },
  { pattern: /from\s+now\s+on/i, score: 0.2, label: "persistent-directive" },
  { pattern: /your\s+new\s+(role|personality|instructions?|behavior)/i, score: 0.2, label: "role-reassign" },
];

// Block when a single high-confidence injection pattern is present — a lone
// "you are now a …" or "disregard all previous …" is already a poisoning
// attempt and must not require a second corroborating pattern.
export const MEMORY_BLOCK_SINGLE = 0.85;
// Or when weaker signals accumulate past this combined score.
export const MEMORY_BLOCK_CUMULATIVE = 0.3;
