/**
 * resolveBackgroundModel — the one place that answers "which model should
 * non-load-bearing background work (classifiers, dream) run on?"
 *
 * backgroundModelFor() in registry.ts stays a pure static lookup: declared
 * backgroundModel, else the caller's fallback. That's correct for every cloud
 * provider, whose fast model always exists. It is NOT sufficient for providers
 * whose catalog is DISCOVERED (`local`, `ollama-cloud` — the two with an empty
 * static `models` list), because there is no id we could safely declare: any
 * hardcoded local model 404s for every user who hasn't pulled it.
 *
 * So dynamic-catalog providers resolve in three tiers, most explicit first:
 *
 *   1. `localClassifierModel` setting — the user said so; nothing outranks it.
 *   2. Discovered smallest eligible model — small, non-reasoning, non-embedding
 *      (see local-runtimes/classifier-model.ts).
 *   3. The caller's fallback (the chat model) — exactly today's behavior, so a
 *      box with nothing suitable is never made worse.
 *
 * Async because tiers 1-2 read the settings + local-runtime caches, which
 * registry.ts must not statically depend on (it's a leaf contract imported
 * almost everywhere; pulling discovery + network probes into its import graph
 * would be a real cost for a value only two providers need).
 */
import { PROVIDERS, backgroundModelFor } from "./registry.js";
import type { ProviderId } from "./provider-ids.js";

/** True for providers whose model list is populated at runtime, not declared. */
export function hasDynamicCatalog(provider: ProviderId): boolean {
  const meta = PROVIDERS[provider];
  return !!meta && meta.models.length === 0;
}

export async function resolveBackgroundModel(
  provider: ProviderId,
  fallback: string,
): Promise<string> {
  // A declared backgroundModel is the provider author's explicit choice — it
  // wins outright, and keeps every cloud provider on exactly its current path.
  const declared = PROVIDERS[provider]?.backgroundModel;
  if (declared) return declared;

  if (hasDynamicCatalog(provider)) {
    try {
      const { getSetting } = await import("../settings.js");
      const pinned = getSetting<string>("localClassifierModel");
      if (typeof pinned === "string" && pinned.trim()) return pinned.trim();
    } catch { /* settings unreadable — fall through to discovery */ }

    try {
      const { pickLocalClassifierModel } = await import("../local-runtimes/index.js");
      const auto = pickLocalClassifierModel();
      if (auto) return auto;
    } catch { /* discovery unavailable — fall through to the caller's fallback */ }
  }

  return backgroundModelFor(provider, fallback);
}
