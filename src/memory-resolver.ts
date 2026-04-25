/**
 * Memory Resolver — Mem0-style write-time conflict resolution.
 *
 * When a new fact arrives, compare it against the top-K semantically similar
 * existing facts and let an LLM pick one of four operations:
 *
 *   - ADD:    insert as a new fact (no conflict with existing knowledge)
 *   - UPDATE: supersedes a specific existing fact (invalidate old, insert new)
 *   - DELETE: the new info says the old fact is no longer true (invalidate, don't insert)
 *   - NOOP:   the new "fact" is duplicate or contradicted by stronger existing evidence
 *
 * Design principles:
 *   - Uses whichever LLM is already configured (Ollama → Anthropic → OpenAI → NOOP fallback)
 *   - Zero cost if the user doesn't opt in (retainSmart is separate from retain)
 *   - Returns a structured decision, no side effects — caller applies the operation
 *   - Temperature 0, short max_tokens, cheap models only
 */
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

export type ResolverOp = "ADD" | "UPDATE" | "DELETE" | "NOOP";

export interface ResolverCandidate {
  id: number;
  content: string;
  kind: string;
  timestamp: number;
}

export interface ResolverDecision {
  op: ResolverOp;
  targetId?: number;      // populated for UPDATE and DELETE
  reason: string;         // short human-readable explanation
}

export interface ResolverOptions {
  provider?: "ollama" | "anthropic" | "openai" | "auto";
  model?: string;
  timeoutMs?: number;
}

/**
 * Classify a new fact against existing similar candidates.
 * Returns NOOP with reason="no LLM available" if nothing is configured — safe fallback.
 */
export async function resolveFact(
  newFact: string,
  candidates: ResolverCandidate[],
  opts: ResolverOptions = {}
): Promise<ResolverDecision> {
  if (candidates.length === 0) {
    return { op: "ADD", reason: "no similar existing facts" };
  }

  const prompt = buildPrompt(newFact, candidates);
  const raw = await callLLM(prompt, opts);
  if (!raw) return { op: "NOOP", reason: "no LLM available — defaulted to NOOP (skip)" };

  return parseDecision(raw, candidates);
}

function buildPrompt(newFact: string, candidates: ResolverCandidate[]): string {
  const list = candidates.map((c, i) => `[${i + 1}] id=${c.id} (${c.kind}): ${c.content}`).join("\n");
  return `You are a memory resolver. A new fact has just arrived. Compare it against existing facts and decide what to do.

NEW FACT:
${newFact}

EXISTING CANDIDATES:
${list}

Pick ONE operation:
- ADD    — genuinely new info, no conflict with existing
- UPDATE — refines or supersedes a specific candidate (the old one is now stale but not wrong)
- DELETE — contradicts a specific candidate (the old one is now false)
- NOOP   — duplicate of existing, or too weak to save

Respond with EXACTLY ONE LINE in this format:
OP=<ADD|UPDATE|DELETE|NOOP> TARGET=<candidate_id or -> REASON=<short reason, max 12 words>

Examples:
OP=ADD TARGET=- REASON=new info about a new topic
OP=UPDATE TARGET=42 REASON=refines existing fact with specific details
OP=DELETE TARGET=17 REASON=user switched to keto, no longer likes italian
OP=NOOP TARGET=- REASON=duplicate of candidate 3

Your response (one line only):`;
}

function parseDecision(raw: string, candidates: ResolverCandidate[]): ResolverDecision {
  // Search the entire response — LLMs sometimes split OP/TARGET/REASON across lines
  // or wrap them in code fences / quotes.
  const text = raw.trim();
  const opMatch = text.match(/OP\s*=\s*(ADD|UPDATE|DELETE|NOOP)/i);
  const targetMatch = text.match(/TARGET\s*=\s*([0-9]+|-)/i);
  // Reason can span to end-of-line OR end-of-string, tolerant of quotes/backticks
  const reasonMatch = text.match(/REASON\s*=\s*["'`]?([^"'`\n]+?)["'`]?\s*(?:$|\n)/i);

  const op = (opMatch?.[1].toUpperCase() || "NOOP") as ResolverOp;
  const reason = (reasonMatch?.[1] || "unparsed").trim().slice(0, 120);
  let targetId: number | undefined;
  if (targetMatch && targetMatch[1] !== "-") {
    const id = parseInt(targetMatch[1]);
    // Validate the id actually matches one of the candidates (LLM hallucination guard)
    if (candidates.some(c => c.id === id)) targetId = id;
  }

  // Guard: UPDATE/DELETE without a valid target → downgrade to NOOP
  if ((op === "UPDATE" || op === "DELETE") && targetId === undefined) {
    return { op: "NOOP", reason: `LLM returned ${op} without valid target — defaulted to NOOP` };
  }

  return { op, targetId, reason };
}

async function callLLM(prompt: string, opts: ResolverOptions): Promise<string | null> {
  const timeout = opts.timeoutMs ?? 15_000;
  const provider = opts.provider === "auto" || !opts.provider ? detectProvider() : opts.provider;

  if (provider === "ollama") return callOllama(prompt, opts.model || "qwen2.5:3b", timeout);
  if (provider === "anthropic") return callAnthropic(prompt, opts.model || "claude-haiku-4-5-20251001", timeout);
  if (provider === "openai") return callOpenAI(prompt, opts.model || "gpt-4o-mini", timeout);
  return null;
}

/** Detect which LLM is available. Prefers local (Ollama) for cost + latency. */
function detectProvider(): "ollama" | "anthropic" | "openai" | null {
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
  return "ollama"; // last-ditch attempt — will fail gracefully if not running
}

async function callOllama(prompt: string, model: string, timeoutMs: number): Promise<string | null> {
  try {
    const res = await fetch("http://localhost:11434/api/generate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model, prompt, stream: false, options: { temperature: 0, num_predict: 80 } }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) return null;
    const data = await res.json() as { response?: string };
    return data.response || null;
  } catch { return null; }
}

async function callAnthropic(prompt: string, model: string, timeoutMs: number): Promise<string | null> {
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
      body: JSON.stringify({ model, max_tokens: 80, temperature: 0, messages: [{ role: "user", content: prompt }] }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) return null;
    const data = await res.json() as { content?: Array<{ text?: string }> };
    return data.content?.[0]?.text || null;
  } catch { return null; }
}

async function callOpenAI(prompt: string, model: string, timeoutMs: number): Promise<string | null> {
  try {
    const apiKey = process.env.OPENAI_API_KEY || "";
    if (!apiKey) return null;
    const res = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({
        model, temperature: 0, max_tokens: 80,
        messages: [{ role: "user", content: prompt }],
      }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) return null;
    const data = await res.json() as { choices?: Array<{ message?: { content?: string } }> };
    return data.choices?.[0]?.message?.content || null;
  } catch { return null; }
}
