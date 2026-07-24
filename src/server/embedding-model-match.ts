/**
 * Pure matching + decision logic for the boot-time embedding model probe.
 * Extracted from bootstrap-services so the tag-matching rules are testable
 * without dragging in the whole server bootstrap graph.
 *
 * Ollama registers models under a full `name:tag` (e.g. `mxbai-embed-large:335m`
 * or `mxbai-embed-large:latest`). The old check stripped only `:latest`, so a
 * model installed as `:335m` never matched a bare target name and got re-pulled
 * (~670MB) on every boot.
 */
import { isEmbeddingModel } from "../canonical-loop/model-capabilities.js";

/**
 * Does `targetModel` match any of `installedNames`?
 * - Bare target (no `:tag`): matches any installed model whose base name
 *   (before `:`) equals it — `mxbai-embed-large` matches `:335m` and `:latest`.
 * - Explicit tag: exact match required, with `:latest` equivalence to a bare
 *   installed name (`foo:latest` === `foo`).
 */
export function embeddingModelInstalled(targetModel: string, installedNames: string[]): boolean {
  const withDefaultTag = (n: string) => (n.includes(":") ? n : `${n}:latest`);
  if (!targetModel.includes(":")) {
    return installedNames.some(n => n.split(":", 1)[0] === targetModel);
  }
  const target = withDefaultTag(targetModel);
  return installedNames.some(n => withDefaultTag(n) === target);
}

export type EmbeddingModelDecision =
  | { action: "use" }
  | { action: "pull" }
  | { action: "retry"; reason: string }
  | { action: "refuse"; reason: string };

/**
 * Decide what the boot warmer should do given a `/api/tags` probe result.
 * An unreachable Ollama (cold start, 3s probe timeout) must NOT trigger a
 * pull — the empty tag list only means "couldn't ask", so the caller returns
 * a retryable degraded result and warmEmbeddingsWithRetry re-probes later.
 *
 * `refuse` is the auto-pull invariant (added after a broken Settings
 * dropdown saved `gpt-oss:120b` as embeddingModel and boot silently pulled
 * and warmed a 65GB chat model, wedging the box): the warmer must never
 * USE or PULL a model it cannot justify as an embedder. Justification is
 * the runtime's authoritative capabilities flag for installed models, or
 * the name heuristic (isEmbeddingModel) as backstop / for not-yet-pulled
 * targets. Callers handle `refuse` by falling back to a known-good
 * default and surfacing the bad setting — never by pulling anyway.
 */
export function decideEmbeddingModelAction(
  targetModel: string,
  tags: { reachable: boolean; models: Array<{ name: string; embeddingOnly?: boolean }> },
): EmbeddingModelDecision {
  if (!tags.reachable) return { action: "retry", reason: "ollama-unreachable" };
  const names = tags.models.map(m => m.name);
  if (embeddingModelInstalled(targetModel, names)) {
    const entry = tags.models.find(m => embeddingModelInstalled(targetModel, [m.name]));
    if (entry?.embeddingOnly || isEmbeddingModel(targetModel)) return { action: "use" };
    return { action: "refuse", reason: "is installed but is not an embedding model (runtime reports it as chat-capable and its name matches no embedding family)" };
  }
  if (!isEmbeddingModel(targetModel)) {
    return { action: "refuse", reason: "is not a recognized embedding model — refusing to auto-download it" };
  }
  return { action: "pull" };
}
