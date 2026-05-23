import { createHash } from "node:crypto";

import { STOP_WORDS } from "./constants.js";

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

export function extractRelationships(text: string): string[] {
  const relationships: string[] = [];
  const patterns = [
    /(\w[\w\s]*?)\s+(?:works?\s+(?:at|for|on))\s+(\w[\w\s]*?)(?:\.|,|$)/gi,
    /(\w[\w\s]*?)\s+(?:lives?\s+in|based\s+in)\s+(\w[\w\s]*?)(?:\.|,|$)/gi,
    /(\w[\w\s]*?)\s+(?:likes?|loves?|hates?)\s+(\w[\w\s]*?)(?:\.|,|$)/gi,
    /(\w[\w\s]*?)\s+(?:is\s+a|is\s+the)\s+(\w[\w\s]*?)(?:\.|,|$)/gi,
  ];

  for (const pattern of patterns) {
    let match;
    while ((match = pattern.exec(text)) !== null) {
      relationships.push(`${match[1].trim()} -> ${match[2].trim()}`);
    }
  }

  return relationships;
}
