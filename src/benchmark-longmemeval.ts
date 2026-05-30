/**
 * LongMemEval Benchmark Runner v3
 *
 * Key fix: measures retrieval the same way MemPalace does —
 * checks if the correct SESSION was retrieved (by session ID),
 * not whether the answer text appears in the snippet.
 *
 * Also: R@10, proper session IDs, full text matching as secondary.
 *
 * Usage: npx tsx src/benchmark-longmemeval.ts [--k 10] [--limit 10]
 */

import { readFileSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { MemoryIndex } from "./memory/index.js";
import { chunkConversationPairs } from "./memory/chunking.js";
import type { ChunkMetadata } from "./memory/index.js";

import { createLogger } from "./logger.js";
const logger = createLogger("benchmark-longmemeval");

const DATA_PATH = process.argv.includes("--data")
  ? process.argv[process.argv.indexOf("--data") + 1]
  : "workspace/benchmarks/longmemeval/longmemeval_s_cleaned.json";

const K = process.argv.includes("--k")
  ? parseInt(process.argv[process.argv.indexOf("--k") + 1])
  : 10;

const EMB_MODEL = process.argv.includes("--emb-model")
  ? process.argv[process.argv.indexOf("--emb-model") + 1]
  : "nomic-embed-text";

const EMB_URL = process.argv.includes("--emb-url")
  ? process.argv[process.argv.indexOf("--emb-url") + 1]
  : undefined;

const LIMIT = process.argv.includes("--limit")
  ? parseInt(process.argv[process.argv.indexOf("--limit") + 1])
  : 0;

const VERBOSE = process.argv.includes("--verbose") || process.argv.includes("-v");
const USE_HYDE = process.argv.includes("--hyde");
const HYDE_MODEL = process.argv.includes("--hyde-model")
  ? process.argv[process.argv.indexOf("--hyde-model") + 1]
  : undefined;
const HYDE_PROVIDER = process.argv.includes("--hyde-provider")
  ? process.argv[process.argv.indexOf("--hyde-provider") + 1] as "ollama" | "anthropic" | "openai" | "auto"
  : undefined;

interface BenchmarkItem {
  question_id: string;
  question_type: string;
  question: string;
  answer: string | number;
  answer_session_ids: string[];
  haystack_dates?: string[];
  haystack_session_ids?: string[];
  haystack_sessions: Array<Record<string, { role: string; content: string }>>;
}

async function main() {
  logger.info("=== LongMemEval Benchmark v3 (session-ID matching) ===");
  logger.info(`Data: ${DATA_PATH} | K: ${K}`);

  if (!existsSync(DATA_PATH)) { logger.error(`Not found: ${DATA_PATH}`); process.exit(1); }

  logger.info("Loading...");
  const items: BenchmarkItem[] = JSON.parse(readFileSync(DATA_PATH, "utf-8"));
  const testItems = LIMIT > 0 ? items.slice(0, LIMIT) : items;
  logger.info(`${items.length} items, testing ${testItems.length}`);

  const benchDir = join("workspace", "benchmarks", "longmemeval", "_bench_db");
  if (existsSync(benchDir)) rmSync(benchDir, { recursive: true });
  mkdirSync(benchDir, { recursive: true });
  const memory = new MemoryIndex(benchDir);

  try {
    const { createEmbeddingProvider } = await import("./embedding-providers/index.js");
    const embProvider = createEmbeddingProvider({ provider: "ollama", model: EMB_MODEL, baseUrl: EMB_URL });
    memory.setEmbeddingProvider(embProvider);
    const source = EMB_URL ? `(${EMB_URL})` : "ollama";
    logger.info(`Embedding: ${source}/${EMB_MODEL} (${embProvider.dimensions}d)`);
  } catch { logger.info("Keyword search only"); }

  const scores: Record<string, { hits: number; total: number }> = {};
  let totalHits = 0;
  let totalQueries = 0;
  const startTime = Date.now();

  for (let qi = 0; qi < testItems.length; qi++) {
    const item = testItems[qi];
    const qType = item.question_type;
    if (!scores[qType]) scores[qType] = { hits: 0, total: 0 };

    // Build set of answer session IDs for this question
    try {
    const answerIds = new Set(item.answer_session_ids);

    // Phase 1: Ingest sessions using real session IDs from haystack_session_ids
    const sessionPaths: string[] = [];
    for (let si = 0; si < item.haystack_sessions.length; si++) {
      const session = item.haystack_sessions[si];
      const turnKeys = Object.keys(session).sort((a, b) => Number(a) - Number(b));
      const messages = turnKeys.map(k => ({
        role: session[k].role as "user" | "assistant",
        content: session[k].content,
      })).filter(m => m.content && (m.role === "user" || m.role === "assistant"));

      if (messages.length < 2) continue;

      // Use the REAL session ID from the benchmark data
      const realSessionId = item.haystack_session_ids?.[si] || `s${si}`;
      const metadata: ChunkMetadata = {
        source_type: "import",
        session_id: realSessionId,
        date: item.haystack_dates?.[si] || undefined,
      };
      const virtualPath = `bench/${item.question_id}/${realSessionId}`;
      const chunks = chunkConversationPairs(messages, virtualPath, "import", metadata);
      if (chunks.length > 0) {
        await memory.indexChunks(chunks, virtualPath, "import");
        sessionPaths.push(virtualPath);
      }
    }

    // Phase 2: Search with session grouping, temporal boost, and optional rerank
    const useRerank = process.argv.includes("--rerank");
    const rerankProvider = process.argv.includes("--rerank-provider")
      ? process.argv[process.argv.indexOf("--rerank-provider") + 1]
      : undefined;
    const results = await memory.search(item.question, {
      maxResults: K, minScore: 0.001,
      rerank: useRerank, rerankModel: rerankProvider ? `provider:${rerankProvider}` : undefined,
      hyde: USE_HYDE, hydeModel: HYDE_MODEL, hydeProvider: HYDE_PROVIDER,
    });

    // Phase 3: Check if ANY returned chunk comes from an answer session
    // This is how MemPalace measures — did you retrieve the right session?
    const hit = results.some(r => {
      if (r.metadata?.session_id && answerIds.has(r.metadata.session_id)) return true;
      // Fallback: check if the path contains an answer session ID
      for (const aid of answerIds) {
        if (r.path.includes(aid)) return true;
      }
      return false;
    });

    if (hit) { totalHits++; scores[qType].hits++; }
    scores[qType].total++;
    totalQueries++;

    const pct = Math.round((qi + 1) / testItems.length * 100);
    const recall = Math.round(totalHits / totalQueries * 1000) / 10;
    const elapsed = Math.round((Date.now() - startTime) / 1000);
    const rate = Math.max(0.01, (qi + 1) / elapsed);
    const eta = Math.round((testItems.length - qi - 1) / rate);
    if (VERBOSE) {
      const qSnippet = item.question.replace(/\s+/g, " ").slice(0, 80);
      logger.info(`[${pct}%] ${qi + 1}/${testItems.length} | R@${K}=${recall}% | ${qType} ${hit ? "✓" : "✗"} | "${qSnippet}" | ETA ${Math.floor(eta/60)}m${eta%60}s`);
    } else {
      process.stdout.write(`\r[${pct}%] ${qi + 1}/${testItems.length} | R@${K}: ${recall}% | ${qType} ${hit ? "✓" : "✗"} | ETA: ${Math.floor(eta/60)}m${eta%60}s  `);
    }

    // Cleanup — typed call so a missing removeFile fails loudly instead of
    // silently leaving prior questions' haystacks in the index (the bug that
    // tanked measured recall when removeFile moved off the class).
    for (const p of sessionPaths) {
      memory.removeFile(p);
    }
    } catch (e) {
      logger.warn(`\n[bench] Question ${qi + 1} failed: ${(e as Error).message}`);
      scores[qType].total++;
      totalQueries++;
    }
  }

  const totalTime = Math.round((Date.now() - startTime) / 1000);
  logger.info(`\n\n=== RESULTS (${Math.floor(totalTime/60)}m${totalTime%60}s) ===`);
  logger.info(`Overall Recall@${K}: ${(totalHits / totalQueries * 100).toFixed(1)}% (${totalHits}/${totalQueries})`);
  logger.info("\nBy question type:");
  for (const [type, s] of Object.entries(scores).sort((a, b) => a[0].localeCompare(b[0]))) {
    logger.info(`  ${type}: ${(s.hits / s.total * 100).toFixed(1)}% (${s.hits}/${s.total})`);
  }
  logger.info(`\nMemPalace reference: 96.6% R@5 / ~98% R@10 (zero API)`);

  try { memory.close(); } catch {}
  rmSync(benchDir, { recursive: true, force: true });
}

main().catch(e => { logger.error(e); process.exit(1); });
