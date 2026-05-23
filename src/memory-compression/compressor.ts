import { join } from "node:path";

import { COMPRESSED_DIR, MS_PER_DAY } from "./constants.js";
import {
  ensureDirs,
  listStoredFiles,
  loadStored,
  readStoredFile,
  writeStored,
  writeStoredAtPath,
} from "./persistence.js";
import { toKeypoints, toSkeleton, toSummary } from "./strategies.js";
import { estimateTokens, generateId } from "./text-utils.js";
import type {
  CompressedSession,
  CompressionLevel,
  CompressionReport,
  StoredCompression,
} from "./types.js";

const LEVEL_ORDER: CompressionLevel[] = ["full", "summary", "keypoints", "skeleton"];

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

  compress(content: string, level: CompressionLevel): string {
    switch (level) {
      case "full":
        return content;
      case "summary":
        return toSummary(content);
      case "keypoints":
        return toKeypoints(content);
      case "skeleton":
        return toSkeleton(content);
    }
  }

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

    const stored: StoredCompression = {
      ...session,
      createdAt: Date.now(),
      ageAtCompression: 0,
    };
    writeStored(stored);

    return session;
  }

  decompressToLevel(memoryId: string, level: CompressionLevel): string {
    const stored = loadStored(memoryId);
    if (!stored) return `[memory ${memoryId} not found]`;
    return stored.levels[level] || stored.levels.full || "";
  }

  autoCompress(ageInDays: number): CompressionLevel {
    if (ageInDays <= 7) return "full";
    if (ageInDays <= 30) return "summary";
    if (ageInDays <= 90) return "keypoints";
    return "skeleton";
  }

  compressAll(dryRun = false): CompressionReport {
    const report: CompressionReport = {
      processed: 0,
      compressed: 0,
      savedTokens: 0,
      byLevel: { full: 0, summary: 0, keypoints: 0, skeleton: 0 },
    };

    for (const file of listStoredFiles()) {
      report.processed++;
      const filePath = join(COMPRESSED_DIR, file);
      const stored = readStoredFile(filePath);
      if (!stored) continue;

      const ageInDays = (Date.now() - stored.createdAt) / MS_PER_DAY;
      const targetLevel = this.autoCompress(ageInDays);

      const currentLevel = this.effectiveLevel(stored);
      const currentIdx = LEVEL_ORDER.indexOf(currentLevel);
      const targetIdx = LEVEL_ORDER.indexOf(targetLevel);

      if (targetIdx <= currentIdx) {
        report.byLevel[currentLevel]++;
        continue;
      }

      if (!dryRun) {
        if (!stored.levels[targetLevel] || stored.levels[targetLevel] === stored.levels.full) {
          stored.levels[targetLevel] = this.compress(stored.levels.full, targetLevel);
        }

        for (let i = 0; i < targetIdx; i++) {
          const lvl = LEVEL_ORDER[i];
          if (lvl !== targetLevel) {
            const before = estimateTokens(stored.levels[lvl] || "");
            report.savedTokens += before;
            if (lvl === "full" && targetLevel !== "full") {
              stored.levels[lvl] = "[compressed — use lower resolution]";
            }
          }
        }

        stored.ageAtCompression = ageInDays;
        stored.compressedTokens = estimateTokens(stored.levels[targetLevel]);
        writeStoredAtPath(filePath, stored);
      }

      report.compressed++;
      report.byLevel[targetLevel]++;
    }

    return report;
  }

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
