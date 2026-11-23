/**
 * Memory system — pure helper functions.
 *
 * No side effects (beyond file I/O helpers). No dependencies on the DB or
 * class state. Safe to import from anywhere.
 */
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { containsNulByte } from "../binary-sniff.js";
import { redact } from "../security/secrets/index.js";
import { contentWords } from "./text-utils.js";
import type { FactKind, RetainedFact } from "./types.js";
import type { MemoryContentOrigin } from "./promotion-gate.js";

// ── File I/O helpers ──

/**
 * The canonical atomic write, re-exported so memory-local importers keep
 * working. This used to be a memory-local FORK of util/json-store.ts — same
 * tmp+rename idea, but missing that copy's bounded EPERM/EBUSY retry for
 * rename contention, which is the Windows hazard. SessionStore, the hottest
 * writer in the app, was on the fork. There is now one implementation; add
 * behaviour THERE, not here.
 */
export { atomicWriteFileSync } from "../util/json-store.js";

/** Read a text file safely: strips BOM, normalizes CRLF, skips binary. */
export function safeReadTextFile(filePath: string): string | null {
  try {
    let content = readFileSync(filePath, "utf-8");
    if (content.charCodeAt(0) === 0xfeff) content = content.slice(1);
    if (containsNulByte(content)) return null;
    return content.replace(/\r\n/g, "\n");
  } catch { return null; }
}

// ── Credential redaction ──

// Memory-only PII shapes (NOT credentials — they stay out of the shared
// catalog so the egress guard doesn't false-positive on every 16-digit
// number). Credential shapes live in security/credential-patterns.ts; add
// new ones THERE, not here.
const MEMORY_PII_PATTERNS = [
  /\b\d{4}[- ]?\d{4}[- ]?\d{4}[- ]?\d{4}\b/g, // Credit card numbers
];

/** At-rest redaction for the memory index: the canonical credential catalog
 *  (security/credential-patterns.ts) plus memory-local PII shapes. */
export function redactCredentials(text: string): string {
  let redacted = redact(text);
  for (const pattern of MEMORY_PII_PATTERNS) {
    redacted = redacted.replace(pattern, "[REDACTED]");
  }
  return redacted;
}

// ── Query processing ──

/** A message's search keywords: its content words (text-utils.ts), down to two
 *  letters, because "ai", "pr" and "ui" are things people ask about. */
export function extractKeywords(raw: string): string[] {
  return contentWords(raw, 2);
}

const ftsTerm = (k: string) => `"${k.replace(/"/g, '""')}"`;

export function buildFtsQuery(raw: string): string {
  const keywords = extractKeywords(raw);
  if (keywords.length === 0) return "";
  return keywords.map(ftsTerm).join(" AND ");
}

/**
 * Most terms an any-term query carries. The bound is the point: an FTS5 OR
 * costs roughly linear in its terms, and the message it is built from has no
 * length limit — a pasted file would otherwise buy an unbounded query. 64 unique
 * terms measured 93ms against the 25k-chunk index; every term 167ms.
 */
export const FTS_ANY_MAX_TERMS = 64;

/**
 * "Any of these words", as ONE query, for when every-word matched nothing. bm25
 * over an OR already ranks a chunk that hits more of the terms above one that
 * hits a single term, so this is a better ordering than the best-single-term
 * score it replaces — not just a faster one. Terms keep message order (the ask
 * usually leads) and are de-duplicated before the cap is applied.
 */
export function buildFtsAnyQuery(raw: string, maxTerms: number = FTS_ANY_MAX_TERMS): string {
  const unique = [...new Set(extractKeywords(raw))].slice(0, maxTerms);
  return unique.map(ftsTerm).join(" OR ");
}

// ── Fact parsing (for ## Retain sections in daily logs) ──

const KIND_PREFIX: Record<string, FactKind> = {
  W: "world",
  O: "opinion",
  E: "experience",
  S: "observation",
};

/**
 * An entity mention ("@Kaleb"), the one rule every memory reader and writer
 * shares. The "@" must not follow a letter, digit or address character: inside
 * "biaoto.ka@gmail.com" it is part of an email address, and reading "@gmail"
 * as a mention dropped the "@" from a saved address and named "gmail" an
 * entity (2026-11-18). Group 1 is the name.
 */
export const ENTITY_MENTION_SOURCE = String.raw`(?<![\w.+%'-])@([\w-]+)`;

/** A fresh mention regex (a shared global one would carry lastIndex between callers). */
export function entityMentionRe(flags = "g", suffix = ""): RegExp {
  return new RegExp(ENTITY_MENTION_SOURCE + suffix, flags);
}

/** The names mentioned with "@" in a text, in order. */
export function entityMentions(text: string): string[] {
  return [...text.matchAll(entityMentionRe())].map((m) => m[1]!);
}

export function parseFactLine(
  line: string
): { kind: FactKind; content: string; entities: string[]; confidence: number } | null {
  const prefixMatch = line.match(/^([WOES])(?:\(c=(\d+\.?\d*)\))?\s+(.*)/);

  let kind: FactKind = "observation";
  let confidence = 1.0;
  let rest = line;

  if (prefixMatch) {
    kind = KIND_PREFIX[prefixMatch[1]] || "observation";
    confidence = prefixMatch[2] ? parseFloat(prefixMatch[2]) : 1.0;
    rest = prefixMatch[3];
  } else if (/^[A-Z](?:\(c=\d+\.?\d*\))?\s/.test(line)) {
    // Looks prefix-shaped (capital letter + optional (c=...) + space) but the
    // letter isn't in the schema-aligned set. The legacy "B" (behavior) prefix
    // from older dream output lands here. Drop instead of silently smuggling
    // the malformed prefix into observation content.
    return null;
  }

  const entities = entityMentions(rest);

  // The name stays in the sentence; only the "@" marks it as an entity.
  // Deleting it stored "is the user's cousin" and "owns a sailboat named the ,
  // which she keeps at slip 31 in" — sentences no reader can cite, and the
  // nameless cousin fact is what a resolver mistook for a revision of an
  // unrelated story about the same person (2026-10-09). A leading label
  // ("@Dana: likes tea") names the subject, so it opens the sentence unless
  // the sentence already says it; a tag the next word repeats ("@rex Rex
  // passed away") is only a tag.
  const label = /^((?:@[\w-]+[,\s]*)+):\s*/.exec(rest);
  const content0 = (label ? rest.slice(label[0].length) : rest)
    .replace(entityMentionRe("gi", String.raw`\s+(?=\1\b)`), "")
    .replace(entityMentionRe(), "$1")
    .trim();
  const unsaid = label
    ? (label[1].match(/@([\w-]+)/g) ?? []).map((m) => m.slice(1)).filter((name) => !content0.toLowerCase().includes(name.toLowerCase()))
    : [];
  const content = unsaid.length > 0 ? `${unsaid.join(", ")} ${content0}` : content0;
  if (!content0) return null;

  return { kind, content, entities, confidence: Math.max(0, Math.min(1, confidence)) };
}

// Facts written before 2026-10-09 had their @-names deleted from content
// ("@Dana is the user's wife" stored as "is the user's wife"); parseFactLine
// now keeps them. Tool responses and previews still list the entities so
// those older rows read with their names.
export function displayContent(fact: Pick<RetainedFact, "content" | "entities">): string {
  if (!fact.entities || fact.entities.length === 0) return fact.content;
  return `${fact.content} (@${fact.entities.join(", @")})`;
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
    occurredAt: (row.occurred_at as number | null) ?? null,
    validFrom: (row.valid_from as number | null) ?? undefined,
    validTo: (row.valid_to as number | null) ?? null,
    invalidatedBy: (row.invalidated_by as number | null) ?? null,
    invalidationReason: (row.invalidation_reason as string | null) ?? null,
    provenance: (row.provenance as MemoryContentOrigin | null) ?? null,
    sourceMessageId: (row.source_message_id as string | null) ?? null,
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

// ── Score normalization ──

export function bm25RankToScore(rank: number): number {
  const relevance = -rank;
  return Math.max(0, Math.min(1, relevance / (1 + Math.abs(relevance))));
}

