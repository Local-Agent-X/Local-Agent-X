/**
 * Sleeptime Consolidation — Letta-style background memory rewrite.
 *
 * Runs while the user is idle (nightly cron). Pulls recent chunks, asks an LLM
 * to extract key facts / patterns / resolved decisions, and writes them through
 * retainSmart — which runs the Mem0-style resolver, so duplicates become NOOPs
 * and contradictions become UPDATEs automatically.
 *
 * Design principles:
 *   - Reuses the resolver + bi-temporal machinery from memory-resolver.ts and memory.ts
 *   - Groups chunks by session/path so each LLM call sees coherent context
 *   - Cheap: one LLM call per session (not per chunk), short output, temp 0
 *   - Non-destructive: only writes new facts, never modifies chunks
 *   - Transparent: returns a per-run summary the user can inspect
 */
import type { MemoryIndex } from "./memory.js";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

export interface ConsolidationOptions {
  lookbackHours?: number;       // default 24
  maxChunksPerSession?: number; // default 50 (cap per LLM call to stay under context)
  maxSessions?: number;         // default 20 (cost cap — skip noisy days)
  provider?: "ollama" | "anthropic" | "openai" | "auto";
  model?: string;
  dryRun?: boolean;             // if true, extract but don't write
}

export interface ConsolidationResult {
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

/** Main entry point — run consolidation against a MemoryIndex. */
export async function runSleeptimeConsolidation(
  memory: MemoryIndex,
  opts: ConsolidationOptions = {}
): Promise<ConsolidationResult> {
  const startedAt = Date.now();
  const lookbackHours = opts.lookbackHours ?? 24;
  const maxChunksPerSession = opts.maxChunksPerSession ?? 50;
  const maxSessions = opts.maxSessions ?? 20;
  const since = startedAt - lookbackHours * 3600_000;

  const result: ConsolidationResult = {
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
 * Returns text in the `- W/O/B/S @entity: content` format that retainSmart consumes.
 */
async function extractFactsFromSession(
  sessionPath: string,
  chunks: ChunkRow[],
  opts: ConsolidationOptions
): Promise<string | null> {
  const provider = opts.provider === "auto" || !opts.provider ? detectProvider() : opts.provider;
  if (!provider) return null;

  const transcript = chunks.map(c => c.text).join("\n---\n").slice(0, 8000); // cap context
  const prompt = buildExtractionPrompt(sessionPath, transcript);

  if (provider === "ollama") return await callOllama(prompt, opts.model || "llama3:8b");
  if (provider === "anthropic") return await callAnthropic(prompt, opts.model || "claude-haiku-4-5-20251001");
  if (provider === "openai") return await callOpenAI(prompt, opts.model || "gpt-4o-mini");
  return null;
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
  W = world fact (objective, verifiable)
  O = opinion / preference
  B = behavior / pattern
  S = schedule / plan

Examples:
- W @user switched crypto exchanges from Coinbase to Kraken
- O @user prefers bash over Python for scripting
- S @user plans to ship ScanProgress v2 by end of April
- B @user writes commit messages in past tense

Skip:
- Information that's only meaningful in the current conversation
- Meta-commentary ("we discussed X")
- Duplicate information

SESSION (${sessionPath}):
${transcript}

Facts (output only the list, nothing else):`;
}

// ── LLM provider plumbing (duplicated minimally from memory-resolver) ──

function detectProvider(): "ollama" | "anthropic" | "openai" | null {
  // For batch consolidation we prefer Ollama — it's local, free, and works
  // reliably for 500+ sequential calls. The user's chat-provider preference
  // (often Anthropic-CLI-subscription, which can't accept direct API calls
  // in bulk) is WRONG for this workload.
  //
  // Precedence: Ollama if reachable → API-key Anthropic → API-key OpenAI
  // → fallback to whatever's saved. Never return a "cli" or "oauth:" path
  // — those can't serve sleeptime traffic.
  if (process.env.ANTHROPIC_API_KEY && process.env.ANTHROPIC_API_KEY.startsWith("sk-ant-api")) return "anthropic";
  if (process.env.OPENAI_API_KEY) return "openai";
  // Ollama is the preferred default for batch consolidation
  return "ollama";
  // (legacy settings-based detection kept below for reference but unreachable)
  try {
    const settingsPath = join(homedir(), ".lax", "settings.json");
    if (existsSync(settingsPath)) {
      const s = JSON.parse(readFileSync(settingsPath, "utf-8")) as { provider?: string };
      if (s.provider === "ollama") return "ollama";
      if (s.provider === "anthropic") return "anthropic";
      if (s.provider === "openai" || s.provider === "codex") return "openai";
    }
  } catch {}
  if (process.env.ANTHROPIC_API_KEY) return "anthropic";
  if (process.env.OPENAI_API_KEY) return "openai";
  return "ollama";
}

async function callOllama(prompt: string, model: string): Promise<string | null> {
  try {
    const res = await fetch("http://localhost:11434/api/generate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model, prompt, stream: false, options: { temperature: 0, num_predict: 500 } }),
      signal: AbortSignal.timeout(60_000),
    });
    if (!res.ok) return null;
    const data = await res.json() as { response?: string };
    return data.response || null;
  } catch { return null; }
}

async function callAnthropic(prompt: string, model: string): Promise<string | null> {
  try {
    let apiKey = process.env.ANTHROPIC_API_KEY || "";
    if (!apiKey) {
      try { apiKey = await (await import("./auth-anthropic.js")).getAnthropicApiKey(); } catch {}
    }
    if (!apiKey) return null;
    const token = apiKey.startsWith("oauth:") ? apiKey.slice(6) : apiKey;
    const isOAuth = apiKey.startsWith("oauth:");
    const headers: Record<string, string> = { "Content-Type": "application/json", "anthropic-version": "2023-06-01" };
    if (isOAuth) headers["Authorization"] = `Bearer ${token}`;
    else headers["x-api-key"] = token;
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers,
      body: JSON.stringify({ model, max_tokens: 500, temperature: 0, messages: [{ role: "user", content: prompt }] }),
      signal: AbortSignal.timeout(30_000),
    });
    if (!res.ok) return null;
    const data = await res.json() as { content?: Array<{ text?: string }> };
    return data.content?.[0]?.text || null;
  } catch { return null; }
}

async function callOpenAI(prompt: string, model: string): Promise<string | null> {
  try {
    const apiKey = process.env.OPENAI_API_KEY || "";
    if (!apiKey) return null;
    const res = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({
        model, temperature: 0, max_tokens: 500,
        messages: [{ role: "user", content: prompt }],
      }),
      signal: AbortSignal.timeout(30_000),
    });
    if (!res.ok) return null;
    const data = await res.json() as { choices?: Array<{ message?: { content?: string } }> };
    return data.choices?.[0]?.message?.content || null;
  } catch { return null; }
}
