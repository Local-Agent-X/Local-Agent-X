import type { RouteHandler } from "../../server-context.js";
import { jsonResponse, readBody } from "../../server-utils.js";
import { getRuntimeConfig } from "../../config.js";
import { loadSettings, saveSettings } from "../../settings.js";
import { isEmbeddingModel } from "../../canonical-loop/public/op-facts.js";
import type { ProviderId } from "../../providers/provider-ids.js";
import { PROVIDERS, providerRegistryView } from "../../providers/registry.js";
import { refreshCloudOllama, getCachedCloudModels } from "../../ollama-cloud.js";
import { getLocalRuntimes, localRuntimesStale, refreshLocalRuntimes } from "../../local-runtimes/index.js";
import { isLocalOnlyMode, localProviderDecision, LOCAL_ONLY_BLOCK_MESSAGE } from "../../local-only-policy.js";
import { CATALOG_PROVIDERS, catalogStale, pickerModelsFor, refreshProviderCatalog } from "../../providers/model-catalog.js";
import { handleLocalRuntimesRoutes, modelsWithCertification } from "./local-runtimes.js";

export const handleProvidersRoutes: RouteHandler = async (method, url, req, res, ctx, _role) => {
  const json = (status: number, data: unknown) => jsonResponse(res, status, data, req);

  // "Is this provider usable?" asked with the SAME probe the turn asks
  // (PROVIDERS[p].auth.hasCredential — see agent-request/resolve-provider.ts).
  // This endpoint feeds the composer's provider chip, so the hand-rolled
  // credential chain that used to live here let the UI confidently name a
  // provider the turn would refuse to run. One probe, one answer.
  const hasCreds = (id: ProviderId): boolean =>
    PROVIDERS[id].auth.hasCredential({ secretsStore: ctx.secretsStore, configOpenAIKey: ctx.config.openaiApiKey });

  // Providers
  if (method === "GET" && url.pathname === "/api/providers") {
    const providers: Array<{
      id: string; name: string; models: string[]; active: boolean;
      runtimes?: Array<{
        id: string; label: string; kind: string; origin: string; baseUrl: string;
        models: Array<{ id: string; contextWindow: number | null; tools: boolean | null;
          certification: { status: "verified" | "unverified" } }>;
      }>;
    }> = [];
    const localOnly = isLocalOnlyMode();
    const hasOpenAIOAuth = !localOnly && hasCreds("codex");
    // The anthropic adapter counts BOTH our setup-token store (~/.lax) and the
    // CLI's own credential file (~/.claude) — the paste-the-code sign-in writes
    // the latter, and the chat subprocess authenticates from it. Without the CLI
    // check a CLI-signed user is "Connected" in Settings but missing here.
    const hasAnthropicOAuth = !localOnly && hasCreds("anthropic");
    // A pay-as-you-go Anthropic key saved in LAX is its own picker entry: the
    // subscription entry never runs on it (auth-provider.ts), so a user who
    // saved a key must be able to pick the key.
    const hasAnthropicKey = !localOnly && hasCreds("anthropic-api");
    const hasXaiKey = hasCreds("xai");
    const hasCerebrasKey = hasCreds("cerebras");
    const hasOpenAIKey = hasCreds("openai");
    // Resolve current provider/model the same way the request path does
    // (see src/agent-request/resolve-provider.ts). The previous default
    // hardcoded "xai"/"grok-4" here regardless of which creds were
    // actually present; after the install stopped seeding settings.provider
    // (commit 4c9e5c4), every fresh install with no xAI key got a phantom
    // current.provider="xai" the UI couldn't render. Mirror the request-
    // resolution logic so the dropdown reflects what would actually run.
    let currentProvider = "", currentModel = "";
    {
      const s = loadSettings();
      if (s.provider) currentProvider = String(s.provider);
      if (s.model) currentModel = String(s.model);
    }
    if (localOnly) {
      const customBaseUrl = String(loadSettings().customBaseUrl || "");
      currentProvider = localProviderDecision("custom", getRuntimeConfig(), customBaseUrl).allowed ? "custom" : "local";
      currentModel = currentProvider === "custom" ? String(loadSettings().model || "custom-model") : "";
    } else if (!currentProvider) {
      // Auto-detect priority matches resolve-provider.ts's fallback chain
      // so the UI dropdown and the request path agree on which provider
      // is "active by default" when at least one credential is present.
      //
      // Empty state (no creds anywhere) returns currentProvider="" — NOT
      // a hardcoded default. The onboarding gate in the renderer treats
      // `current.provider` as the "user has an active provider" signal,
      // and any falsy-via-truthy default here makes the wizard auto-skip
      // on every fresh install (settings.json then gets onboarded:true
      // POSTed back automatically, locking the wizard out forever).
      // Past attempts patched "Ollama-running-counts-as-onboarded" but
      // this same bug shape kept tripping through other auto-detect
      // branches — fixed at the root.
      if (hasXaiKey) currentProvider = "xai";
      else if (hasAnthropicOAuth) currentProvider = "anthropic";
      else if (hasAnthropicKey) currentProvider = "anthropic-api";
      else if (hasOpenAIOAuth) currentProvider = "codex";
      // No `else` — leave empty so the renderer knows the user needs to
      // pick + connect a provider before they're considered onboarded.
    }
    if (!currentModel && currentProvider) {
      const reg = PROVIDERS[currentProvider as ProviderId];
      if (reg?.defaultModel) currentModel = reg.defaultModel;
    }
    const hasGeminiKey = hasCreds("gemini");
    const hasCustomKey = hasCreds("custom");
    // Provider list, labels, and model arrays derived from PROVIDERS so
    // adding a provider only requires editing registry.ts. The models are the
    // chat picker's: the shipped chat list plus whatever the provider's own
    // list-models endpoint adds (model-catalog.ts) — read from cache, and a
    // stale cache kicks a background refresh; never a round-trip on this path.
    const pushFromRegistry = (id: ProviderId) => {
      if (CATALOG_PROVIDERS.includes(id) && catalogStale(id)) void refreshProviderCatalog(id);
      providers.push({ id, name: PROVIDERS[id].label, models: pickerModelsFor(id), active: currentProvider === id });
    };
    if (hasXaiKey && !localOnly) pushFromRegistry("xai");
    if (hasGeminiKey && !localOnly) pushFromRegistry("gemini");
    if (hasCerebrasKey && !localOnly) pushFromRegistry("cerebras");
    if (hasOpenAIOAuth && !localOnly) pushFromRegistry("codex");
    if (hasAnthropicOAuth && !localOnly) pushFromRegistry("anthropic");
    if (hasAnthropicKey) pushFromRegistry("anthropic-api");
    if (hasOpenAIKey && !localOnly) pushFromRegistry("openai");
    // Local runtimes (Ollama, LM Studio, vLLM, llama.cpp, manual adds) —
    // ONE picker entry whose models are the union across discovered
    // runtimes. Read from the local-runtimes cache (warmed at boot,
    // re-swept every 60s) — never a live probe on this path. The
    // `runtimes` sibling carries per-runtime detail for the settings UI;
    // the flat `models` array keeps the existing renderer working as-is.
    // Deliberate divergence from `hasCreds`: the local adapter is a keyless
    // sentinel (always credentialed), so discovery — not the probe — gates this
    // entry. Stricter than the probe, never looser.
    const localRuntimes = getLocalRuntimes();
    if (localRuntimesStale()) void refreshLocalRuntimes().catch(() => {});
    if (localRuntimes && localRuntimes.length > 0) {
      const union = [...new Set(localRuntimes.flatMap(r => r.models.map(m => m.id)))]
        .filter(n => !isEmbeddingModel(n));
      providers.push({
        id: "local",
        name: PROVIDERS.local.label,
        models: union,
        active: currentProvider === "local",
        runtimes: localRuntimes.map(r => ({
          id: r.id,
          label: r.label,
          kind: r.kind,
          origin: r.endpoint.origin,
          baseUrl: r.endpoint.baseUrl,
          models: modelsWithCertification(r).map(m => ({
            id: m.id,
            contextWindow: m.contextWindow,
            tools: m.tools,
            certification: m.certification,
          })),
        })),
      });
    }
    // Ollama Turbo (cloud) — separate top-level entry so users find it
    // by name in the dropdown. When the API key isn't set yet, we still
    // surface the provider with an empty model list so the picker shows
    // the option (and the connect-key field appears, same UX as xAI/
    // Gemini before keys are added). Deliberate divergence from `hasCreds`:
    // listed keyless with no models — a connect affordance, not a runnable pick.
    if (!localOnly) {
      // Read cloud models from cache — NEVER an inline ollama.com round-trip
      // here. That internet call (only present when a cloud key is set) was
      // the machine-specific 5s stall on the provider-list path. If a key is
      // set but the cache is cold, kick a background refresh and return what
      // we have; bootstrap-services warms it at startup.
      let cloudModels: string[] = [];
      if (hasCreds("ollama-cloud")) {
        cloudModels = getCachedCloudModels();
        if (cloudModels.length === 0) {
          void refreshCloudOllama(ctx.secretsStore, getRuntimeConfig().ollamaCloudUrl).catch(() => {});
        }
      }
      providers.push({
        id: "ollama-cloud",
        name: PROVIDERS["ollama-cloud"].label,
        models: cloudModels,
        active: currentProvider === "ollama-cloud",
      });
    }
    const customBaseUrl = String(loadSettings().customBaseUrl || "");
    if (hasCustomKey && (!localOnly || localProviderDecision("custom", getRuntimeConfig(), customBaseUrl).allowed)) pushFromRegistry("custom");
    json(200, { providers, current: { provider: currentProvider, model: currentModel }, localOnlyMode: localOnly }); return true;
  }

  // Switch provider
  if (method === "POST" && url.pathname === "/api/providers/switch") {
    let body: Record<string, unknown>;
    try { body = JSON.parse(await readBody(req)); } catch { json(400, { error: "Invalid JSON" }); return true; }
    let provider = String(body.provider || "");
    let model = String(body.model || "");
    if (!provider) { json(400, { error: "provider required" }); return true; }
    const customBaseUrl = String(loadSettings().customBaseUrl || "");
    const localDecision = localProviderDecision(provider, getRuntimeConfig(), customBaseUrl);
    if (!localDecision.allowed) { json(403, { error: localDecision.reason || LOCAL_ONLY_BLOCK_MESSAGE, code: "LOCAL_ONLY" }); return true; }

    // Alias: if the user (or agent) asks for "openai" but only OAuth-based
    // Codex is configured, route to codex. Avoids saving a broken
    // provider=openai/model=gpt-5.4 config that dies on every turn.
    if (provider === "openai" && !hasCreds("openai") && hasCreds("codex")) { provider = "codex"; model = model || "gpt-5.4"; }

    const settings = { ...loadSettings() };
    // If no model specified, auto-pick the first model for the new provider —
    // otherwise we'd leave the previous provider's model (e.g. gpt-5.4)
    // paired with a different provider (anthropic) and every next turn would
    // 404 on "model doesn't exist".
    if (!model) {
      // Auto-pick the flagship model from the registry. When PROVIDERS
      // gains a new entry, the dropdown picks up its defaultModel
      // without needing to edit this file.
      const reg = PROVIDERS[provider as ProviderId];
      model = (reg?.defaultModel) || String(settings.model || "");
    }
    settings.provider = provider;
    if (model) settings.model = model;
    saveSettings(settings);
    // Broadcast so every open browser tab (bottom status bar, model selector)
    // updates instantly instead of staying on the stale provider.
    try {
      const { broadcastAll } = await import("../../chat-ws/index.js");
      broadcastAll({ type: "settings_changed", settings: { provider, model } });
    } catch {}
    json(200, { ok: true, provider, model: model || settings.model }); return true;
  }

  // Provider registry — labels + model lists, no creds gating. Lets the Apps
  // gallery dropdown and the Settings model picker render every provider
  // without re-hardcoding the metadata client-side. Model lists carry the
  // provider's catalog additions (cache only) so the two pickers agree.
  if (method === "GET" && url.pathname === "/api/providers/registry") {
    const customBaseUrl = String(loadSettings().customBaseUrl || "");
    const out = (Object.keys(PROVIDERS) as ProviderId[])
      .filter(id => localProviderDecision(id, getRuntimeConfig(), customBaseUrl).allowed)
      .map(id => {
        const view = providerRegistryView(id);
        const chatModels = pickerModelsFor(id);
        return { ...view, chatModels, models: [...new Set([...view.models, ...chatModels])] };
      });
    json(200, { providers: out, localOnlyMode: isLocalOnlyMode() });
    return true;
  }

  // Local runtimes, local Ollama tags, the Turbo connection test and the
  // `ollama serve` launcher live in local-runtimes.ts.
  return handleLocalRuntimesRoutes(method, url, req, res, ctx, _role);
};
