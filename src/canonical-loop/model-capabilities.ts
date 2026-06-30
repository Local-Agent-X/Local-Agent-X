/**
 * Model capability predicates and (eventually) the persistent capability
 * registry that future-proofs the canonical-loop adapters against the
 * "every new model has its own quirks" pattern.
 *
 * Phase 1 (this file): cheap name-pattern predicates — `isEmbeddingModel`
 * is the immediate need (filtering `/api/tags` output so embedding-only
 * models don't show up in the chat-model picker).
 *
 * Phase 2 (the persistent registry): now lives in
 * `src/providers/model-capabilities-store.ts` — a self-healing,
 * publicly-seeded store at `~/.lax/model-capabilities.json` keyed by
 * `(baseURL, model)`. It persists the facts the runtime already learns
 * (tools support, hard-400 params like reasoning_effort/temperature) so they
 * survive restarts, and ships a public seed (model-capabilities-seed.ts) so
 * day-one behavior is correct without phoning home. The openai-http catch and
 * openai-compat empty-response latch write through it via the markNoToolSupport
 * / markParamUnsupported wrappers in providers/types.ts.
 *
 * Still deferred: probe-on-first-use (Ollama /api/show), reasoning-emission
 * and context-window facts (context window stays in context-manager/
 * model-windows.ts for now — a different, lower-pain fact type).
 */

/**
 * Common embedding-model name patterns. Lower-cased match. Covers:
 *   - any name containing "embed" / "embedding" (mxbai-embed-large,
 *     nomic-embed-text, snowflake-arctic-embed, jina-embeddings-v2,
 *     text-embedding-ada-002, granite-embedding, etc.)
 *   - prefix-only families that don't include "embed" in the slug:
 *     bge (BAAI), gte (Alibaba), e5 (Microsoft), all-minilm
 *     (Sentence-Transformers).
 *
 * Bias: false positives (a chat model wrongly tagged embedding-only) are
 * worse than false negatives (an embedding model that slips through) for
 * a chat-model picker — false negatives just produce a clear runtime
 * error when the user picks one. So the regex is intentionally narrow,
 * not maximally aggressive. Edge cases that might slip through: niche
 * embedding models with unusual names (e.g. `instructor-xl`).
 */
const EMBEDDING_NAME_RE = /(^|[/_:.\-])(embed|embedding|embeddings)([_:.\-]|$)|^(bge|gte|e5)[/_:.\-]|^all[/_:.\-]minilm/i;

/**
 * True when the given Ollama model name looks like an embedding-only
 * model. Pure name-based heuristic — no Ollama HTTP calls. Used to
 * filter the chat-model picker so users don't accidentally pick an
 * embedding model and get a runtime "model does not generate" error.
 *
 * For higher confidence, the future capability registry will additionally
 * query `/api/show` and check `capabilities: ["embedding"]` (Ollama 0.4+).
 * Until then, the regex catches the common families.
 */
export function isEmbeddingModel(name: string): boolean {
  if (!name) return false;
  return EMBEDDING_NAME_RE.test(name);
}
