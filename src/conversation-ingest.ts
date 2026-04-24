/**
 * Universal Conversation Ingest Pipeline
 *
 * Ingests chat exports from any supported format into the memory system.
 * Incremental: skips already-ingested conversations.
 * Auto-detects format per file.
 */

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, extname, basename } from "node:path";
import { parseExportFile, detectFormat } from "./conversation-parsers.js";
import { chunkConversationPairs } from "./memory-chunking.js";
import type { ChunkMetadata } from "./memory.js";

// ── Types ──

export interface IngestProgress {
  totalFiles: number;
  currentFile: string;
  totalConversations: number;
  processed: number;
  skipped: number;
  chunksCreated: number;
  errors: number;
}

export type ProgressCallback = (progress: IngestProgress) => void;

export interface IngestResult {
  totalConversations: number;
  processed: number;
  skipped: number;
  chunksCreated: number;
  errors: number;
  formats: Record<string, number>;
}

// ── File scanning ──

const SUPPORTED_EXTENSIONS = new Set([".json", ".jsonl", ".txt", ".md"]);
const MAX_FILE_SIZE = 500 * 1024 * 1024; // 500MB safety limit

function scanExportFiles(dirPath: string): string[] {
  if (!existsSync(dirPath)) return [];
  const stat = statSync(dirPath);
  if (!stat.isDirectory()) return SUPPORTED_EXTENSIONS.has(extname(dirPath).toLowerCase()) ? [dirPath] : [];

  const files: string[] = [];
  for (const entry of readdirSync(dirPath, { withFileTypes: true })) {
    if (entry.isDirectory()) continue; // don't recurse — user points at a flat export dir
    if (entry.name.startsWith(".")) continue;
    const ext = extname(entry.name).toLowerCase();
    if (!SUPPORTED_EXTENSIONS.has(ext)) continue;
    const fullPath = join(dirPath, entry.name);
    try {
      const size = statSync(fullPath).size;
      if (size > MAX_FILE_SIZE) { console.warn(`[ingest] Skipping ${entry.name}: too large (${Math.round(size / 1e6)}MB)`); continue; }
      if (size < 10) continue; // empty/trivial file
    } catch { continue; }
    files.push(fullPath);
  }
  return files.sort();
}

// ── Main ingest function ──

export async function ingestConversations(
  memory: any, // MemoryIndex — any to avoid circular import
  path: string,
  onProgress?: ProgressCallback,
): Promise<IngestResult> {
  const files = scanExportFiles(path);
  const result: IngestResult = { totalConversations: 0, processed: 0, skipped: 0, chunksCreated: 0, errors: 0, formats: {} };

  // Pre-count total conversations across all files for accurate progress
  let globalTotal = 0;
  for (const filePath of files) {
    try {
      const content = readFileSync(filePath, "utf-8");
      const ext = extname(filePath).toLowerCase();
      const parsed = parseExportFile(content, ext);
      globalTotal += parsed.length;
    } catch { /* skip unreadable files */ }
  }

  const progress: IngestProgress = { totalFiles: files.length, currentFile: "", totalConversations: globalTotal, processed: 0, skipped: 0, chunksCreated: 0, errors: 0 };
  onProgress?.(progress);

  for (const filePath of files) {
    progress.currentFile = basename(filePath);

    try {
      const fileResult = await ingestSingleFile(memory, filePath, onProgress ? (p) => {
        progress.processed = result.processed + p.processed;
        progress.skipped = result.skipped + p.skipped;
        progress.chunksCreated = result.chunksCreated + p.chunksCreated;
        progress.errors = result.errors + p.errors;
        onProgress(progress);
      } : undefined);

      result.totalConversations += fileResult.totalConversations;
      result.processed += fileResult.processed;
      result.skipped += fileResult.skipped;
      result.chunksCreated += fileResult.chunksCreated;
      result.errors += fileResult.errors;
      for (const [fmt, count] of Object.entries(fileResult.formats)) {
        result.formats[fmt] = (result.formats[fmt] || 0) + count;
      }
    } catch (e) {
      console.error(`[ingest] Failed to process ${basename(filePath)}:`, (e as Error).message);
      result.errors++;
    }
  }

  // After ingest: run sleeptime consolidation in the background to auto-promote
  // durable facts (surgeries, launches, moves, preferences) from the imported
  // chunks into MIND.md + the facts table. Fire-and-forget so the ingest call
  // returns immediately — consolidation runs async and logs progress.
  if (result.chunksCreated > 0) {
    console.log(`[ingest] Kicking off background consolidation for ${result.chunksCreated} new chunks (365-day lookback)...`);
    (async () => {
      try {
        const { runSleeptimeConsolidation } = await import("./memory-sleeptime.js");
        const t0 = Date.now();
        const summary = await runSleeptimeConsolidation(memory, {
          lookbackHours: 365 * 24, // full year — covers typical ChatGPT history exports
          maxSessions: 500,        // cap per-run cost
          maxChunksPerSession: 50,
        });
        const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
        const ops = summary.operations;
        console.log(`[ingest] Consolidation done in ${elapsed}s — sessions=${summary.sessionsAnalyzed} facts=${summary.factsExtracted} add=${ops.add} update=${ops.update} delete=${ops.delete} noop=${ops.noop}`);
      } catch (e) {
        console.warn(`[ingest] Background consolidation failed: ${(e as Error).message}`);
      }
    })();
  }

  return result;
}

// ── Single file ingest ──

async function ingestSingleFile(
  memory: any,
  filePath: string,
  onProgress?: ProgressCallback,
): Promise<IngestResult> {
  const result: IngestResult = { totalConversations: 0, processed: 0, skipped: 0, chunksCreated: 0, errors: 0, formats: {} };
  const progress: IngestProgress = { totalFiles: 1, currentFile: basename(filePath), totalConversations: 0, processed: 0, skipped: 0, chunksCreated: 0, errors: 0 };

  const content = readFileSync(filePath, "utf-8");
  const ext = extname(filePath).toLowerCase();
  const format = detectFormat(content, ext);

  if (format === "unknown") {
    console.warn(`[ingest] Unknown format: ${basename(filePath)}`);
    return result;
  }

  // For ChatGPT: file is an array of conversations — parse in streaming fashion
  // to avoid holding entire parsed structure in memory
  let conversations;
  try {
    conversations = parseExportFile(content, ext);
  } catch (e) {
    console.error(`[ingest] Parse error in ${basename(filePath)}:`, (e as Error).message);
    result.errors++;
    return result;
  }

  result.totalConversations = conversations.length;
  progress.totalConversations = conversations.length;

  for (const convo of conversations) {
    try {
      // Skip already-ingested conversations
      if (memory.isConversationIngested(convo.id)) {
        result.skipped++;
        progress.skipped++;
        onProgress?.(progress);
        continue;
      }

      if (convo.messages.length < 2) {
        result.skipped++;
        progress.skipped++;
        continue;
      }

      // Build metadata
      const metadata: ChunkMetadata = {
        source_type: "import",
        session_id: convo.id,
        date: convo.createTime ? new Date(convo.createTime).toISOString().split("T")[0] : undefined,
      };

      // Chunk as conversation pairs
      const virtualPath = `import/${convo.source}/${convo.id}`;
      const chunks = chunkConversationPairs(convo.messages, virtualPath, "import", metadata);

      if (chunks.length === 0) {
        result.skipped++;
        continue;
      }

      // Index chunks through the memory system
      console.log(`[ingest] Indexing ${chunks.length} chunks for ${convo.id.slice(0, 8)}...`);
      await memory.indexChunks(chunks, virtualPath, "import");
      console.log(`[ingest] Indexed ${chunks.length} chunks for ${convo.id.slice(0, 8)}.`);

      // Mark as ingested
      memory.markConversationIngested(convo.id, convo.title, convo.createTime || 0, convo.messages.length, convo.source);

      result.processed++;
      result.chunksCreated += chunks.length;
      result.formats[convo.source] = (result.formats[convo.source] || 0) + 1;
      progress.processed++;
      progress.chunksCreated += chunks.length;
      onProgress?.(progress);

    } catch (e) {
      console.error(`[ingest] Error ingesting conversation ${convo.id}:`, (e as Error).message);
      result.errors++;
      progress.errors++;
    }
  }

  return result;
}
