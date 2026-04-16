/**
 * Memory system — pure helper functions.
 *
 * No side effects (beyond file I/O helpers). No dependencies on the DB or
 * class state. Safe to import from anywhere.
 */
import { writeFileSync, readFileSync, renameSync, unlinkSync } from "node:fs";
import { randomBytes, createHash } from "node:crypto";
import type { FactKind, RetainedFact } from "./types.js";

// ── File I/O helpers ──

export function atomicWriteFileSync(filePath: string, content: string): void {
  const tmpPath = filePath + ".tmp." + randomBytes(4).toString("hex");
  try {
    writeFileSync(tmpPath, content, "utf-8");
    renameSync(tmpPath, filePath);
  } catch (e) {
    try { unlinkSync(tmpPath); } catch {}
    throw e;
  }
}

/** Read a text file safely: strips BOM, normalizes CRLF, skips binary. */
export function safeReadTextFile(filePath: string): string | null {
  try {
    let content = readFileSync(filePath, "utf-8");
    if (content.charCodeAt(0) === 0xfeff) content = content.slice(1);
    if (content.includes("\0")) return null;
    return content.replace(/\r\n/g, "\n");
  } catch { return null; }
}

// ── Stop words + credential redaction ──

export const STOP_WORDS = new Set([
  "a", "an", "and", "are", "as", "at", "be", "been", "being", "but", "by",
  "can", "could", "did", "do", "does", "doing", "done", "for", "from",
  "get", "got", "had", "has", "have", "having", "he", "her", "here", "hers",
  "herself", "him", "himself", "his", "how", "i", "if", "in", "into", "is",
  "it", "its", "itself", "just", "let", "like", "ll", "may", "me", "might",
  "my", "myself", "no", "nor", "not", "of", "on", "or", "our", "ours",
  "ourselves", "out", "own", "re", "same", "shall", "she", "should", "so",
  "some", "such", "than", "that", "the", "their", "theirs", "them",
  "themselves", "then", "there", "these", "they", "this", "those", "through",
  "to", "too", "up", "us", "ve", "very", "was", "we", "were", "what",
  "when", "where", "which", "while", "who", "whom", "why", "will", "with",
  "would", "you", "your", "yours", "yourself", "yourselves",
  "about", "after", "again", "all", "also", "am", "any", "because",
  "before", "between", "both", "each", "few", "further", "had", "more",
  "most", "must", "need", "now", "off", "once", "only", "other", "over",
  "please", "really", "right", "say", "since", "still", "tell", "thing",
  "think", "um", "uh", "use", "used", "using", "want", "well", "went",
]);

const CREDENTIAL_PATTERNS = [
  /(?:sk|pk|api[_-]?key|token|secret|password|passwd|auth)[-_]?[a-zA-Z0-9]{20,}/gi,
  /(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9_]{36,}/g,           // GitHub tokens
  /xoxb-[0-9]+-[0-9]+-[a-zA-Z0-9]+/g,                      // Slack tokens
  /eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g, // JWTs
  /-----BEGIN (?:RSA |EC )?PRIVATE KEY-----[\s\S]*?-----END/g,
  /AKIA[0-9A-Z]{16}/g,                                       // AWS keys
  /(?:mongodb|postgres|mysql|redis):\/\/[^\s]+/gi,           // Database URLs with passwords
  /\b\d{4}[- ]?\d{4}[- ]?\d{4}[- ]?\d{4}\b/g,             // Credit card numbers
  /npm_[A-Za-z0-9]{36,}/g,                                   // npm tokens
  /(?:Bearer|Basic)\s+[A-Za-z0-9_\-.~+/]+=*/gi,            // Authorization headers
];

export function redactCredentials(text: string): string {
  let redacted = text;
  for (const pattern of CREDENTIAL_PATTERNS) {
    redacted = redacted.replace(pattern, "[REDACTED]");
  }
  return redacted;
}

// ── Query processing ──

export function extractKeywords(raw: string): string[] {
  return raw
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s_]/gu, " ")
    .split(/\s+/)
    .filter((t) => t.length > 1 && !STOP_WORDS.has(t));
}

export function buildFtsQuery(raw: string): string {
  const keywords = extractKeywords(raw);
  if (keywords.length === 0) return "";
  return keywords.map((k) => `"${k.replace(/"/g, '""')}"`).join(" AND ");
}

// ── Fact parsing (for ## Retain sections in daily logs) ──

const KIND_PREFIX: Record<string, FactKind> = {
  W: "world",
  B: "experience",
  O: "opinion",
  S: "observation",
};

export function parseFactLine(
  line: string
): { kind: FactKind; content: string; entities: string[]; confidence: number } | null {
  const prefixMatch = line.match(/^([WBOS])(?:\(c=(\d+\.?\d*)\))?\s+(.*)/);

  let kind: FactKind = "observation";
  let confidence = 1.0;
  let rest = line;

  if (prefixMatch) {
    kind = KIND_PREFIX[prefixMatch[1]] || "observation";
    confidence = prefixMatch[2] ? parseFloat(prefixMatch[2]) : 1.0;
    rest = prefixMatch[3];
  }

  const entityMatches = rest.match(/@([\w-]+)/g) || [];
  const entities = entityMatches.map((m) => m.slice(1));

  const content = rest.replace(/@[\w-]+:?\s*/g, "").trim();
  if (!content) return null;

  return { kind, content, entities, confidence: Math.max(0, Math.min(1, confidence)) };
}

export function rowToFact(row: Record<string, unknown>): RetainedFact {
  return {
    id: row.id as number,
    kind: row.kind as FactKind,
    content: row.content as string,
    entities: JSON.parse((row.entities as string) || "[]"),
    confidence: row.confidence as number,
    evidenceFor: JSON.parse((row.evidence_for as string) || "[]"),
    evidenceAgainst: JSON.parse((row.evidence_against as string) || "[]"),
    sourceFile: row.source_file as string,
    sourceLine: row.source_line as number,
    timestamp: row.timestamp as number,
    lastUpdated: row.last_updated as number,
    validFrom: (row.valid_from as number | null) ?? undefined,
    validTo: (row.valid_to as number | null) ?? null,
    invalidatedBy: (row.invalidated_by as number | null) ?? null,
    invalidationReason: (row.invalidation_reason as string | null) ?? null,
  };
}

export function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

// ── Math / hashing / async ──

export function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length) return 0;
  let dot = 0, normA = 0, normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom === 0 ? 0 : dot / denom;
}

export function tokenize(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .replace(/[^\p{L}\p{N}\s_]/gu, " ")
      .split(/\s+/)
      .filter((t) => t.length > 1 && !STOP_WORDS.has(t))
  );
}

export function jaccardSimilarity(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 1;
  let intersection = 0;
  const [smaller, larger] = a.size <= b.size ? [a, b] : [b, a];
  for (const token of smaller) {
    if (larger.has(token)) intersection++;
  }
  const union = a.size + b.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

// ── Score normalization ──

export function bm25RankToScore(rank: number): number {
  const relevance = -rank;
  return Math.max(0, Math.min(1, relevance / (1 + Math.abs(relevance))));
}

export function normalizeScores(results: { score: number }[]): void {
  if (results.length === 0) return;
  const max = Math.max(...results.map((r) => r.score));
  const min = Math.min(...results.map((r) => r.score));
  const range = max - min;
  if (range === 0) {
    for (const r of results) r.score = 1;
    return;
  }
  for (const r of results) {
    r.score = (r.score - min) / range;
  }
}
