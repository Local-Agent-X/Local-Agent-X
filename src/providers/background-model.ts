/**
 * resolveBackgroundModel — the one place that answers "which model should
 * non-load-bearing background work (classifiers, dream) run on?"
 *
 * Every provider answers with the chat model (the caller's fallback): a cloud
 * provider's declared fast tier may not be served to the user's account, and
 * side work runs on the model the user is on. backgroundModelFor() in
 * registry.ts, the declared fast tier, is voice's alone. A provider whose
 * catalog is DISCOVERED (`local`, `ollama-cloud` — the two with an empty
 * static `models` list) could not declare one anyway: any hardcoded local model
 * 404s for every user who hasn't pulled it.
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
import type { LocalRuntimeKind } from "../local-runtimes/types.js";

export interface BackgroundModelResolution {
  model: string;
  certifiedLocalTarget?: CertifiedLocalClassifierTarget;
  /** When background work runs on the local chat model: the discovered runtime
   *  serving it, the same one chat requests go to (resolve-target.ts,
   *  getRuntimeForModel). Not a guess between runtimes — the answer chat
   *  already acts on. Absent means default Ollama, as for chat. */
  chatRuntime?: { runtimeId: string; kind: LocalRuntimeKind; endpointBaseUrl: string; chatBaseUrl: string };
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
  // A cloud provider's background work runs on the chat model too. Its declared
  // backgroundModel (claude-haiku-4-5, gpt-5.4-mini, …) is a model the user's
  // account may not serve: a ChatGPT plan refuses gpt-5.4-mini ("not supported
  // when using Codex with a ChatGPT account"), so every classifier on it did
  // nothing (2026-10-23). The chat model is the one model known to work, since
  // the chat runs on it, and the owner's rule is that side work runs on the model
  // the user is on (2026-09-23). The declared fast tier is voice's alone
  // (server/voice-model.ts).
  if (!hasDynamicCatalog(provider)) return { model: fallback || backgroundModelFor(provider, "") };

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

  // No pin: the chat model, at the runtime serving chat.
  if (provider === "local" && fallback) {
    const chatRuntime = await chatRuntimeFor(fallback);
    if (chatRuntime) return { model: fallback, chatRuntime };
  }
  return { model: fallback };
}

/**
 * The discovered runtime serving local `chatModel`, by the rule chat requests
 * route by (resolve-target.ts, getRuntimeForModel); undefined means default
 * Ollama, as chat falls back. Every background path used to assume default
 * Ollama, so with LM Studio serving the chat model every classifier
 * cold-skipped ("not resident" — Ollama never had it) and every memory call
 * 404'd (2026-10-18).
 */
export async function chatRuntimeFor(chatModel: string): Promise<BackgroundModelResolution["chatRuntime"]> {
  try {
    const { getRuntimeForModel } = await import("../local-runtimes/index.js");
    const rt = getRuntimeForModel(chatModel);
    return rt ? { runtimeId: rt.id, kind: rt.kind, endpointBaseUrl: rt.endpoint.baseUrl, chatBaseUrl: rt.chatBaseUrl } : undefined;
  } catch {
    return undefined; // discovery unreadable — default Ollama, exactly as chat falls back
  }
}
