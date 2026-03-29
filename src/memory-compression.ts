/**
 * Open Agent X — Memory Compression
 *
 * Multi-resolution memory storage: keeps four compression levels
 * (full / summary / keypoints / skeleton) so older memories use
 * less space while remaining retrievable at any resolution.
 *
 * Persists compressed versions to ~/.sax/memory-compressed/.
 */

import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  readdirSync,
} from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { createHash } from "node:crypto";

// ══════════════════════════════════════════════════════════
//  Types
// ══════════════════════════════════════════════════════════

export type CompressionLevel = "full" | "summary" | "keypoints" | "skeleton";

export interface CompressedSession {
  id: string;
  levels: Record<CompressionLevel, string>;
  originalTokens: number;
  compressedTokens: number;
}

export interface CompressionReport {
  processed: number;
  compressed: number;
  savedTokens: number;
  byLevel: Record<CompressionLevel, number>;
}

interface StoredCompression {
  id: string;
  levels: Record<CompressionLevel, string>;
  originalTokens: number;
  compressedTokens: number;
  createdAt: number;
  ageAtCompression: number;
}

// ══════════════════════════════════════════════════════════
//  Constants
// ══════════════════════════════════════════════════════════

const SAX_DIR = join(homedir(), ".sax");
const COMPRESSED_DIR = join(SAX_DIR, "memory-compressed");
const MS_PER_DAY = 86_400_000;

// Stop words filtered out during compression
const STOP_WORDS = new Set([
  "the", "a", "an", "is", "are", "was", "were", "be", "been", "being",
  "have", "has", "had", "do", "does", "did", "will", "would", "could",
  "should", "may", "might", "shall", "can", "need", "dare", "ought",
  "used", "to", "of", "in", "for", "on", "with", "at", "by", "from",
  "as", "into", "through", "during", "before", "after", "above", "below",
  "between", "out", "off", "over", "under", "again", "further", "then",
  "once", "here", "there", "when", "where", "why", "how", "all", "each",
  "every", "both", "few", "more", "most", "other", "some", "such", "no",
  "not", "only", "own", "same", "so", "than", "too", "very", "just",
  "because", "but", "and", "or", "if", "while", "that", "this", "these",
  "those", "it", "its", "i", "me", "my", "we", "our", "you", "your",
  "he", "him", "his", "she", "her", "they", "them", "their", "what",
  "which", "who", "whom", "also", "about", "up",
]);

// ══════════════════════════════════════════════════════════
//  Helpers
// ══════════════════════════════════════════════════════════

function ensureDirs(): void {
  for (const dir of [SAX_DIR, COMPRESSED_DIR]) {
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  }
}

function estimateTokens(text: string): number {
  // Rough estimate: ~4 chars per token
  return Math.ceil(text.length / 4);
}

function generateId(content: string): string {
  return createHash("sha256").update(content).digest("hex").slice(0, 16);
}

function splitSentences(text: string): string[] {
  return text
    .split(/(?<=[.!?])\s+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

function isContentWord(word: string): boolean {
  return word.length > 2 && !STOP_WORDS.has(word.toLowerCase());
}

function extractEntities(text: string): string[] {
  const entities: string[] = [];

  // @mentions
  const mentions = text.match(/@([\w-]+)/g);
  if (mentions) entities.push(...mentions.map((m) => m.slice(1)));

  // Capitalized proper nouns (2+ chars, not sentence-start heuristic)
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

function extractRelationships(text: string): string[] {
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

// ══════════════════════════════════════════════════════════
//  MemoryCompressor (singleton)
// ══════════════════════════════════════════════════════════

export class MemoryCompressor {
  private static instance: MemoryCompressor;

  private constructor() {
    ensureDirs();
  }

  static getInstance(): MemoryCompressor {
    if (!MemoryCompressor.instance) {
      MemoryCompressor.instance = new MemoryCompressor();
    }
    return MemoryCompressor.instance;
  }

  // ── Compress content to a given level ─────────────────────

  compress(content: string, level: CompressionLevel): string {
    switch (level) {
      case "full":
        return content;

      case "summary":
        return this.toSummary(content);

      case "keypoints":
        return this.toKeypoints(content);

      case "skeleton":
        return this.toSkeleton(content);
    }
  }

  // ── Compress a full chat session ──────────────────────────

  compressSession(messages: { role: string; content: string }[]): CompressedSession {
    const fullText = messages
      .map((m) => `[${m.role}]: ${m.content}`)
      .join("\n\n");

    const id = generateId(fullText);
    const levels: Record<CompressionLevel, string> = {
      full: fullText,
      summary: this.compress(fullText, "summary"),
      keypoints: this.compress(fullText, "keypoints"),
      skeleton: this.compress(fullText, "skeleton"),
    };

    const originalTokens = estimateTokens(fullText);
    const compressedTokens = estimateTokens(levels.keypoints);

    const session: CompressedSession = { id, levels, originalTokens, compressedTokens };

    // Persist all levels
    const stored: StoredCompression = {
      ...session,
      createdAt: Date.now(),
      ageAtCompression: 0,
    };
    writeFileSync(
      join(COMPRESSED_DIR, `${id}.json`),
      JSON.stringify(stored, null, 2),
      "utf-8"
    );

    return session;
  }

  // ── Retrieve a specific compression level ─────────────────

  decompressToLevel(memoryId: string, level: CompressionLevel): string {
    const filePath = join(COMPRESSED_DIR, `${memoryId}.json`);
    if (!existsSync(filePath)) {
      return `[memory ${memoryId} not found]`;
    }

    const stored: StoredCompression = JSON.parse(
      readFileSync(filePath, "utf-8")
    );

    return stored.levels[level] || stored.levels.full || "";
  }

  // ── Auto-determine compression level by age ───────────────

  autoCompress(ageInDays: number): CompressionLevel {
    if (ageInDays <= 7) return "full";
    if (ageInDays <= 30) return "summary";
    if (ageInDays <= 90) return "keypoints";
    return "skeleton";
  }

  // ── Compress all stored memories based on age ─────────────

  compressAll(dryRun = false): CompressionReport {
    const report: CompressionReport = {
      processed: 0,
      compressed: 0,
      savedTokens: 0,
      byLevel: { full: 0, summary: 0, keypoints: 0, skeleton: 0 },
    };

    if (!existsSync(COMPRESSED_DIR)) return report;

    const files = readdirSync(COMPRESSED_DIR).filter((f) => f.endsWith(".json"));

    for (const file of files) {
      report.processed++;
      const filePath = join(COMPRESSED_DIR, file);

      let stored: StoredCompression;
      try {
        stored = JSON.parse(readFileSync(filePath, "utf-8"));
      } catch {
        continue;
      }

      const ageInDays = (Date.now() - stored.createdAt) / MS_PER_DAY;
      const targetLevel = this.autoCompress(ageInDays);

      // Determine current effective level
      const currentLevel = this.effectiveLevel(stored);
      const levelOrder: CompressionLevel[] = ["full", "summary", "keypoints", "skeleton"];
      const currentIdx = levelOrder.indexOf(currentLevel);
      const targetIdx = levelOrder.indexOf(targetLevel);

      // Only compress further, never decompress
      if (targetIdx <= currentIdx) {
        report.byLevel[currentLevel]++;
        continue;
      }

      if (!dryRun) {
        // Generate the target level if not already present
        if (!stored.levels[targetLevel] || stored.levels[targetLevel] === stored.levels.full) {
          stored.levels[targetLevel] = this.compress(stored.levels.full, targetLevel);
        }

        // Remove higher-resolution levels to save space
        for (let i = 0; i < targetIdx; i++) {
          const lvl = levelOrder[i];
          if (lvl !== targetLevel) {
            const before = estimateTokens(stored.levels[lvl] || "");
            report.savedTokens += before;
            // Keep a stub so decompressToLevel knows it was removed
            if (lvl === "full" && targetLevel !== "full") {
              stored.levels[lvl] = "[compressed — use lower resolution]";
            }
          }
        }

        stored.ageAtCompression = ageInDays;
        stored.compressedTokens = estimateTokens(stored.levels[targetLevel]);
        writeFileSync(filePath, JSON.stringify(stored, null, 2), "utf-8");
      }

      report.compressed++;
      report.byLevel[targetLevel]++;
    }

    return report;
  }

  // ── Private compression methods ───────────────────────────

  /**
   * SUMMARY: Extract key facts, ~30% of original length.
   */
  private toSummary(content: string): string {
    const sentences = splitSentences(content);
    if (sentences.length === 0) return content;

    // Score sentences by information density
    const scored = sentences.map((s) => {
      const words = s.split(/\s+/);
      const contentWords = words.filter(isContentWord);
      const density = words.length > 0 ? contentWords.length / words.length : 0;
      const hasEntity = /@[\w-]+/.test(s) || /[A-Z][a-z]{2,}/.test(s);
      const hasNumber = /\d+/.test(s);
      const score = density + (hasEntity ? 0.2 : 0) + (hasNumber ? 0.1 : 0);
      return { sentence: s, score };
    });

    // Keep top ~30% of sentences
    scored.sort((a, b) => b.score - a.score);
    const keepCount = Math.max(1, Math.ceil(sentences.length * 0.3));
    const kept = scored.slice(0, keepCount).map((s) => s.sentence);

    // Restore original order
    const original = sentences.filter((s) => kept.includes(s));
    return original.join(" ");
  }

  /**
   * KEYPOINTS: Bullet points only, ~10% of original.
   */
  private toKeypoints(content: string): string {
    const sentences = splitSentences(content);
    if (sentences.length === 0) return content;

    const points: string[] = [];
    for (const s of sentences) {
      const contentWords = s
        .split(/\s+/)
        .filter(isContentWord);
      if (contentWords.length < 2) continue;

      // Extract the core subject-verb-object
      const compressed = contentWords.slice(0, 8).join(" ");
      if (compressed.length > 5) {
        points.push(`- ${compressed}`);
      }
    }

    // De-duplicate similar points
    const unique: string[] = [];
    for (const p of points) {
      const isDupe = unique.some((u) => {
        const uWords = new Set(u.toLowerCase().split(/\s+/));
        const pWords = p.toLowerCase().split(/\s+/);
        let overlap = 0;
        for (const w of pWords) {
          if (uWords.has(w)) overlap++;
        }
        return overlap / pWords.length > 0.7;
      });
      if (!isDupe) unique.push(p);
    }

    // Keep ~10% worth
    const keepCount = Math.max(1, Math.ceil(sentences.length * 0.1));
    return unique.slice(0, keepCount).join("\n");
  }

  /**
   * SKELETON: Entities + relationships only, ~5% of original.
   */
  private toSkeleton(content: string): string {
    const entities = extractEntities(content);
    const relationships = extractRelationships(content);

    const lines: string[] = [];

    if (entities.length > 0) {
      lines.push("Entities: " + entities.join(", "));
    }

    if (relationships.length > 0) {
      lines.push("Relations:");
      for (const rel of relationships.slice(0, 10)) {
        lines.push(`  ${rel}`);
      }
    }

    if (lines.length === 0) {
      // Fallback: extract just nouns/proper nouns
      const words = content.split(/\s+/).filter(isContentWord);
      const topWords = [...new Set(words)].slice(0, 10);
      lines.push("Keywords: " + topWords.join(", "));
    }

    return lines.join("\n");
  }

  /**
   * Determine the current effective compression level of a stored entry.
   */
  private effectiveLevel(stored: StoredCompression): CompressionLevel {
    if (
      stored.levels.full &&
      stored.levels.full !== "[compressed — use lower resolution]"
    ) {
      return "full";
    }
    if (stored.levels.summary) return "summary";
    if (stored.levels.keypoints) return "keypoints";
    return "skeleton";
  }
}
