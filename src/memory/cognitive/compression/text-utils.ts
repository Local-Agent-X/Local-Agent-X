import { createHash } from "node:crypto";

import { STOP_WORDS } from "./constants.js";
import { extractRelationTriples } from "../../relation-patterns.js";

export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

export function generateId(content: string): string {
  return createHash("sha256").update(content).digest("hex").slice(0, 16);
}

export function splitSentences(text: string): string[] {
  return text
    .split(/(?<=[.!?])\s+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

export function isContentWord(word: string): boolean {
  return word.length > 2 && !STOP_WORDS.has(word.toLowerCase());
}

export function extractEntities(text: string): string[] {
  const entities: string[] = [];

  const mentions = text.match(/@([\w-]+)/g);
  if (mentions) entities.push(...mentions.map((m) => m.slice(1)));

  const proper = text.match(/(?:^|\.\s+)?\b([A-Z][a-z]{2,}(?:\s+[A-Z][a-z]+)*)\b/g);
  if (proper) {
    for (const p of proper) {
      const cleaned = p.replace(/^\.\s*/, "").trim();
      if (cleaned.length > 2 && !STOP_WORDS.has(cleaned.toLowerCase())) {
        entities.push(cleaned);
      }
    }
  }

  return [...new Set(entities)];
}

// "X is a/the Y" type assertions. Local to compression — "is" is deliberately
// excluded from the shared graph vocabulary (too noisy for edges), but it's
// useful context in a lossy skeleton.
const IS_A_RE = /(\w[\w\s]*?)\s+is\s+(?:a|the)\s+(\w[\w\s]*?)(?:\.|,|$)/gi;

export function extractRelationships(text: string): string[] {
  const rels = extractRelationTriples(text, extractEntities(text)).map(
    (t) => `${t.subject} -> ${t.object}`
  );
  IS_A_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = IS_A_RE.exec(text)) !== null) {
    rels.push(`${m[1].trim()} -> ${m[2].trim()}`);
  }
  return rels;
}
