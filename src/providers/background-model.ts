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
 * Dynamic-catalog providers resolve explicitly pinned, then the chat model.
 *
 *   1. `localClassifierModel` setting — the user said so; nothing outranks it.
 *      A pinned model is also served its certified target when one matches.
 *   2. The caller's fallback (the chat model).
 *
 * A small model is no longer auto-selected. Measured 2026-09-18 on this box,
 * llama3.2:3b answered 3 of 8 routing cases correctly against muse-glimmer:30b's
 * 7 of 8: it saved a one-off command as a durable fact, dropped a stated
 * preference ("stop asking before you run the tests"), kept an unrelated memory
 * as on-topic, and emitted two JSON objects for a follow-up verdict. Those are
 * memory pollution and noisy recall, paid by every local user who happened to
 * have a small model pulled. Routing work is also CONDITIONAL — the follow-up
 * verdict fires only on 3-12 word messages, relevance only when session signals
 * exist, and the memory write is fire-and-forget — so the chat model's extra
 * ~1.2s lands on a minority of turns rather than all of them. A user who wants
 * the small model back pins it.
 *
 * Async because tiers 1-2 read the settings + local-runtime caches, which
 * registry.ts must not statically depend on (it's a leaf contract imported
 * almost everywhere; pulling discovery + network probes into its import graph
 * would be a real cost for a value only two providers need).
 */
import { PROVIDERS, backgroundModelFor } from "./registry.js";
import type { ProviderId } from "./provider-ids.js";
import type { CertifiedLocalClassifierTarget } from "../local-runtimes/classifier-model.js";

export interface BackgroundModelResolution {
  model: string;
  certifiedLocalTarget?: CertifiedLocalClassifierTarget;
}

/** True for providers whose model list is populated at runtime, not declared. */
export function hasDynamicCatalog(provider: ProviderId): boolean {
  const meta = PROVIDERS[provider];
  return !!meta && meta.models.length === 0;
}

export async function resolveBackgroundModel(
  provider: ProviderId,
  fallback: string,
): Promise<BackgroundModelResolution> {
  // A declared backgroundModel is the provider author's explicit choice — it
  // wins outright, and keeps every cloud provider on exactly its current path.
  const declared = PROVIDERS[provider]?.backgroundModel;
  if (declared) return { model: declared };

  if (hasDynamicCatalog(provider)) {
    let pinned = "";
    try {
      const { getSetting } = await import("../settings.js");
      // This setting predates multi-runtime evidence and stores only a model
      // string. Keep its legacy default-Ollama transport; model-id lookup would
      // guess when two runtimes expose the same id.
      pinned = (getSetting<string>("localClassifierModel") ?? "").trim();
    } catch { /* settings unreadable — fall through to the chat model */ }

    if (pinned) {
      if (provider === "local") {
        // A bare id cannot say which runtime serves it; a certification can.
        // Scoped narrowly on purpose: this lookup is an ENRICHMENT, so nothing
        // it does may cost the user their pin. One try/catch around both reads
        // meant a throw here fell through to the chat model — the user's
        // explicit choice silently replaced by the 27B they were avoiding.
        try {
          const { certifiedTargetForModel } = await import("../local-runtimes/index.js");
          const certifiedLocalTarget = certifiedTargetForModel(pinned);
          if (certifiedLocalTarget) return { model: pinned, certifiedLocalTarget };
        } catch { /* no certification evidence — the pin itself still stands */ }
      }
      return { model: pinned };
    }
  }

  return { model: backgroundModelFor(provider, fallback) };
}
