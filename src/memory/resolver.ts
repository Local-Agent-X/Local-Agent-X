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
import { dispatch } from "../llm-dispatch.js";

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
  const raw = await dispatch({
    prompt,
    provider: opts.provider,
    ollamaModel: opts.model || "qwen2.5:3b",
    anthropicModel: opts.model,
    openaiModel: opts.model,
    temperature: 0,
    maxTokens: 80,
    timeoutMs: opts.timeoutMs ?? 15_000,
  });
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

