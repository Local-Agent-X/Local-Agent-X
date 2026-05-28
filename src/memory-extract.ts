/**
 * Memory Extract — Letta-style fact extraction from raw chunks.
 *
 * Pulls recent chunks, asks an LLM to extract key facts / patterns / resolved
 * decisions, and writes them through retainSmart — which runs the Mem0-style
 * resolver, so duplicates become NOOPs and contradictions become UPDATEs
 * automatically. Triggered after history imports and on demand via the
 * memory_consolidate tool; not currently on a schedule.
 *
 * Design principles:
 *   - Reuses the resolver + bi-temporal machinery from memory-resolver.ts and memory.ts
 *   - Groups chunks by session/path so each LLM call sees coherent context
 *   - Cheap: one LLM call per session (not per chunk), short output, temp 0
 *   - Non-destructive: only writes new facts, never modifies chunks
 *   - Transparent: returns a per-run summary the user can inspect
 */
import type { MemoryIndex } from "./memory/index.js";
import { dispatch } from "./llm-dispatch.js";

export interface ExtractionOptions {
  lookbackHours?: number;       // default 24
  maxChunksPerSession?: number; // default 50 (cap per LLM call to stay under context)
  maxSessions?: number;         // default 20 (cost cap — skip noisy days)
  provider?: "ollama" | "anthropic" | "openai" | "auto";
  model?: string;
  dryRun?: boolean;             // if true, extract but don't write
}

export interface ExtractionResult {
  startedAt: number;
  finishedAt: number;
  lookbackHours: number;
  sessionsAnalyzed: number;
  chunksAnalyzed: number;
  factsExtracted: number;
  operations: { add: number; update: number; delete: number; noop: number };
  errors: string[];
  decisions: Array<{ session: string; op: string; targetId?: number; reason: string; content: string }>;
}

interface ChunkRow {
  id: number;
  path: string;
  source: string;
  text: string;
  updated_at: number;
}

/** Main entry point — extract facts from recent chunks into the MemoryIndex. */
export async function runExtraction(
  memory: MemoryIndex,
  opts: ExtractionOptions = {}
): Promise<ExtractionResult> {
  const startedAt = Date.now();
  const lookbackHours = opts.lookbackHours ?? 24;
  const maxChunksPerSession = opts.maxChunksPerSession ?? 50;
  const maxSessions = opts.maxSessions ?? 20;
  const since = startedAt - lookbackHours * 3600_000;

  const result: ExtractionResult = {
    startedAt,
    finishedAt: 0,
    lookbackHours,
    sessionsAnalyzed: 0,
    chunksAnalyzed: 0,
    factsExtracted: 0,
    operations: { add: 0, update: 0, delete: 0, noop: 0 },
    errors: [],
    decisions: [],
  };

  // Fetch chunks from the lookback window, grouped by session path
  const rows = (memory as unknown as { db: { prepare: (sql: string) => { all: (...args: unknown[]) => unknown[] } } }).db
    .prepare(
      `SELECT id, path, source, text, updated_at FROM chunks
       WHERE updated_at >= ?
       ORDER BY path, updated_at ASC`
    )
    .all(since) as ChunkRow[];

  if (rows.length === 0) {
    result.finishedAt = Date.now();
    return result;
  }

  // Group by session path
  const bySession = new Map<string, ChunkRow[]>();
  for (const r of rows) {
    let arr = bySession.get(r.path);
    if (!arr) { arr = []; bySession.set(r.path, arr); }
    arr.push(r);
  }

  // Cost cap: if too many sessions changed, skip (probably a bulk import, not normal use)
  const sessionPaths = [...bySession.keys()].slice(0, maxSessions);
  if (bySession.size > maxSessions) {
    result.errors.push(`Skipped ${bySession.size - maxSessions} sessions beyond maxSessions cap`);
  }

  for (const sessionPath of sessionPaths) {
    const chunks = bySession.get(sessionPath)!.slice(0, maxChunksPerSession);
    result.sessionsAnalyzed++;
    result.chunksAnalyzed += chunks.length;

    try {
      const extractedText = await extractFactsFromSession(sessionPath, chunks, opts);
      if (!extractedText) {
        // Every null response is a silent failure — log the first few so
        // the user knows something's wrong (e.g., Ollama unreachable,
        // API key rejected). Without this, 0-fact runs look successful.
        if (result.errors.length < 5) {
          result.errors.push(`${sessionPath}: LLM returned null (provider unreachable or returned empty)`);
        }
        continue;
      }

      if (opts.dryRun) {
        // In dry run, just count parse-able fact lines
        const lineCount = extractedText.split("\n").filter(l => l.trim().startsWith("- ")).length;
        result.factsExtracted += lineCount;
        continue;
      }

      // Ingest through retainSmart so the resolver deduplicates + updates
      const sourceFile = `consolidation:${sessionPath}`;
      const { facts, decisions } = await memory.retainSmart(extractedText, sourceFile, 0, {
        resolverOpts: { provider: opts.provider, model: opts.model },
      });

      result.factsExtracted += facts.length;
      for (const d of decisions) {
        const opKey = d.op.toLowerCase() as keyof typeof result.operations;
        if (opKey in result.operations) result.operations[opKey]++;
        result.decisions.push({
          session: sessionPath,
          op: d.op,
          targetId: d.targetId,
          reason: d.reason,
          content: d.content.slice(0, 120),
        });
      }
    } catch (e) {
      result.errors.push(`${sessionPath}: ${(e as Error).message}`);
    }
  }

  result.finishedAt = Date.now();
  return result;
}

/**
 * Ask LLM to extract salient facts from a session's chunks.
 * Returns text in the `- W/O/E/S @entity: content` format that retainSmart consumes.
 */
async function extractFactsFromSession(
  sessionPath: string,
  chunks: ChunkRow[],
  opts: ExtractionOptions
): Promise<string | null> {
  const transcript = chunks.map(c => c.text).join("\n---\n").slice(0, 8000); // cap context
  const prompt = buildExtractionPrompt(sessionPath, transcript);

  // Bulk extraction prefers env-only credentials and rejects OAuth — the
  // user's chat-time provider (often CLI subscription) can't serve hundreds
  // of sequential API calls.
  return dispatch({
    prompt,
    provider: opts.provider,
    ollamaModel: opts.model || "llama3:8b",
    anthropicModel: opts.model,
    openaiModel: opts.model,
    temperature: 0,
    maxTokens: 500,
    timeoutMs: 60_000,
    rejectOAuth: true,
    preferEnvKeys: true,
  });
}

function buildExtractionPrompt(sessionPath: string, transcript: string): string {
  return `You are a memory-consolidation assistant. Extract 3-8 durable facts from the session below.

Facts should be:
- DURABLE — still true or relevant weeks from now (not "user is asking about X right now")
- SPECIFIC — names, places, decisions, preferences, outcomes
- ONE IDEA each — don't pack multiple facts into one line
- ATTRIBUTED — tag the main person with @name when clear (default to @user for the user)

Output format (one fact per line, exactly this syntax):
- <KIND> @<entity> <content>

KIND is one of:
  W = world fact (objective, verifiable about the user or their domain)
  O = opinion / preference
  E = experience (life event — births, deaths, moves, milestones, completed actions, plans they're actively pursuing)
  S = observation (behaviors, patterns, recurring notes — things that describe how they operate, not events that happened)

Examples:
- W @user switched crypto exchanges from Coinbase to Kraken
- O @user prefers bash over Python for scripting
- E @user shipped side project v2 last Thursday
- S @user writes commit messages in past tense

Skip:
- Information that's only meaningful in the current conversation
- Meta-commentary ("we discussed X")
- Duplicate information

SESSION (${sessionPath}):
${transcript}

Facts (output only the list, nothing else):`;
}

