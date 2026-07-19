/**
 * Pick a small, fast, non-reasoning local model to run CLASSIFIERS on.
 *
 * Why this exists: `local` is one of only three providers with no registry
 * `backgroundModel` (with `ollama-cloud` and `custom`), so backgroundModelFor()
 * returned the user's CHAT model unchanged and every classifier ran on it. On a
 * 27B that reliably burns the full 8s wallclock and returns null — the verdict
 * silently never runs (live 2026-07-15: `[classifier.intent] wallclock timeout
 * at 8000ms (provider=local)` on qwen3.6:27b, which also cost the build-intent
 * tool_choice pin). Same class of bug as grok-4.3 reasoning through every
 * classifier call (2026-06-26), which is why xAI's backgroundModel is pinned to
 * an explicitly `-non-reasoning` id.
 *
 * Why DISCOVERED and not declared: the cloud providers can hardcode a
 * backgroundModel because their model always exists. A local model only exists
 * if this user pulled it. Hardcoding e.g. "llama3.2:3b" into the registry would
 * 404 every classifier call for anyone who doesn't have it — strictly worse than
 * the slow-but-working path it replaced. So the registry stays honest (no static
 * backgroundModel for local) and the choice is made from what's actually on the
 * box, falling back to today's behavior when there's nothing suitable.
 *
 * The user's explicit `localClassifierModel` setting outranks everything here;
 * this module only answers "what should we pick if they haven't said?".
 */
import { getLocalRuntimes } from "./cache.js";
import { hasPublishedCertification } from "./certification-runner.js";
import { isLocalOnlyMode, isLoopbackUrl } from "../local-only-policy.js";
import type { LocalRuntimeInfo, LocalRuntimeKind } from "./types.js";

export interface CertifiedLocalClassifierTarget {
  /** Routing identity only. Credentials/placeholders are attached at dispatch. */
  runtimeId: string;
  kind: LocalRuntimeKind;
  endpointBaseUrl: string;
  chatBaseUrl: string;
  model: string;
}

/**
 * Upper bound for an auto-picked classifier model. A classifier emits a ~50-token
 * JSON verdict against an 8s budget; anything big enough to miss that budget
 * defeats the purpose. Past this we return null and the caller keeps the chat
 * model — no worse than before, and never a "background" model that's slower than
 * the thing it was supposed to relieve.
 */
const MAX_CLASSIFIER_BYTES = 6e9;

/**
 * Embedding models. THE critical exclusion: mxbai-embed-large is 0.67GB — the
 * smallest model on a typical box — so a naive smallest-wins pick would select an
 * embedding model that cannot answer a chat completion at all, turning a slow
 * classifier into a broken one.
 */
const EMBEDDING_RE = /(^|[/:._-])(embed|bge|gte|e5|minilm)/i;

/**
 * Reasoning/thinking families. A thinking model is the exact failure this whole
 * seam exists to avoid — it spends the budget on chain-of-thought and returns
 * nothing parseable in time. Qwen3 ships hybrid thinking ON by default, so a
 * small qwen3 would be fast on paper and still time out. `qwen3(?!\.)` targets
 * that generation without catching later `qwen3.x` families whose behavior we
 * haven't measured (and which the size cap excludes on this box anyway).
 */
const REASONING_RE = /(^|[/:._-])(qwq|deepseek-r1|marco-o1|qwen3(?!\.)|.*-(thinking|reasoning)(:|$))/i;

/** Ollama-style `name:tag`, LM Studio-style `publisher/model` — both fine. */
export function isEligibleClassifierModel(id: string, sizeBytes: number | undefined): boolean {
  // Unknown size → can't rank it, and an unranked pick could silently be huge.
  // Skip rather than guess; the fallback is the status quo, which is safe.
  if (typeof sizeBytes !== "number" || sizeBytes <= 0) return false;
  if (sizeBytes > MAX_CLASSIFIER_BYTES) return false;
  if (EMBEDDING_RE.test(id)) return false;
  if (REASONING_RE.test(id)) return false;
  return true;
}

function isBetterCandidate(
  candidate: { id: string; sizeBytes: number; runtimeId: string },
  current: { id: string; sizeBytes: number; runtimeId: string } | null,
): boolean {
  if (!current) return true;
  if (candidate.sizeBytes !== current.sizeBytes) return candidate.sizeBytes < current.sizeBytes;
  if (candidate.id !== current.id) return candidate.id < current.id;
  return candidate.runtimeId < current.runtimeId;
}

/**
 * Smallest eligible candidate with a process-local proof of the current
 * certification contract. This only reads discovery and publication caches;
 * it never reads persisted evidence or initiates a certification probe.
 */
export function pickCertifiedLocalClassifierTarget(): CertifiedLocalClassifierTarget | null {
  const runtimes = getLocalRuntimes();
  if (!runtimes) return null;

  let best: {
    id: string;
    sizeBytes: number;
    runtimeId: string;
    runtime: LocalRuntimeInfo;
  } | null = null;
  for (const runtime of runtimes) {
    for (const model of runtime.models) {
      if (!isEligibleClassifierModel(model.id, model.sizeBytes)) continue;
      if (!hasPublishedCertification(runtime, model)) continue;
      const candidate = {
        id: model.id,
        sizeBytes: model.sizeBytes!,
        runtimeId: runtime.id,
        runtime,
      };
      if (isBetterCandidate(candidate, best)) best = candidate;
    }
  }
  if (!best) return null;
  return {
    runtimeId: best.runtime.id,
    kind: best.runtime.kind,
    endpointBaseUrl: best.runtime.endpoint.baseUrl,
    chatBaseUrl: best.runtime.chatBaseUrl,
    model: best.id,
  };
}

/**
 * Cache-only proof that a previously selected endpoint/model pair is still the
 * exact published target. Invalidation, discovery drift, or a certification
 * retry makes this false without initiating identity or scenario probes.
 */
export function isCertifiedLocalClassifierTargetCurrent(
  target: CertifiedLocalClassifierTarget,
): boolean {
  if (isLocalOnlyMode() && !isLoopbackUrl(target.endpointBaseUrl)) return false;
  const runtime = getLocalRuntimes()?.find((candidate) => candidate.id === target.runtimeId);
  if (!runtime
    || runtime.kind !== target.kind
    || runtime.endpoint.baseUrl !== target.endpointBaseUrl
    || runtime.chatBaseUrl !== target.chatBaseUrl) return false;
  const model = runtime.models.find((candidate) => candidate.id === target.model);
  return !!model && hasPublishedCertification(runtime, model);
}

/**
 * Smallest eligible model across every discovered runtime, or null when the box
 * has nothing suitable (caller must then keep its existing fallback).
 *
 * Reads the sync cache only — never triggers a sweep. A classifier is on the hot
 * path of a chat turn and must not block on discovery; a cold cache just means
 * "no pick this turn", which degrades to the pre-existing behavior.
 */
export function pickLocalClassifierModel(): string | null {
  const runtimes = getLocalRuntimes();
  if (!runtimes) return null;

  let best: { id: string; sizeBytes: number } | null = null;
  for (const runtime of runtimes) {
    for (const model of runtime.models) {
      if (!isEligibleClassifierModel(model.id, model.sizeBytes)) continue;
      if (!best || model.sizeBytes! < best.sizeBytes) best = { id: model.id, sizeBytes: model.sizeBytes! };
    }
  }
  return best?.id ?? null;
}
