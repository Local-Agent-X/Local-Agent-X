/**
 * Public model-capability seed — the "stat cards" that ship WITH the app.
 *
 * This is the crowdsourced layer, done WITHOUT phoning home: facts flow TO
 * users (bundled in the build), never FROM them. Nothing here is collected
 * from anyone's machine. A new install gets correct day-one behavior for the
 * models listed below instead of paying for a failed round-trip to discover
 * each quirk; anything not listed is still learned locally on first use and
 * remembered in ~/.lax/model-capabilities.json (see model-capabilities-store).
 *
 * To add a model: open a PR adding an entry. Two rules keep it safe:
 *   1. PUBLIC endpoints only. `baseURL` must be a cloud endpoint that is the
 *      same for everyone (e.g. https://api.x.ai/v1). NEVER put a localhost /
 *      127.0.0.1 Ollama URL here — that key is per-user and belongs only in
 *      the user's own ~/.lax file, not in a shipped seed.
 *   2. Record FACTS the provider actually enforces (a hard 400, a documented
 *      "does not support X"), not guesses. A wrong seed entry degrades every
 *      user; a missing one just costs one local round-trip to relearn.
 *
 * These are "negative capability" facts — things a model REJECTS — so they're
 * additive and safe to union: the store never removes a capability based on a
 * seed, it only avoids sending a param/field we know will be refused.
 */

export interface ModelCapabilitySeedEntry {
  /** OpenAI-compat baseURL this fact applies to. Public cloud endpoints only. */
  baseURL: string;
  /** Exact model id as the provider names it. */
  model: string;
  /** Endpoint rejects the `tools` field entirely (chat-only model). */
  noTools?: boolean;
  /** Request params this (endpoint, model) hard-400s on — e.g. "reasoning_effort". */
  unsupportedParams?: string[];
}

export const MODEL_CAPABILITY_SEED: ReadonlyArray<ModelCapabilitySeedEntry> = [
  // grok-4.20-0309-reasoning 400s the whole request on `reasoning_effort`
  // ("does not support parameter reasoningEffort"). Seeding it lets the first
  // call skip the failed round-trip. (Was hardcoded in providers/types.ts.)
  {
    baseURL: "https://api.x.ai/v1",
    model: "grok-4.20-0309-reasoning",
    unsupportedParams: ["reasoning_effort"],
  },
  // o-series (o3-pro) 400s on a non-default `temperature` — only the default is
  // accepted (see isTemperatureRejection in adapters/openai-http.ts). Omitting
  // it up front is strictly safe: the API falls back to the one value o-series
  // allows. Captured by the failure manifest (eval/op-outcomes/failure-manifest.md).
  {
    baseURL: "https://api.openai.com/v1",
    model: "o3-pro",
    unsupportedParams: ["temperature"],
  },
];
