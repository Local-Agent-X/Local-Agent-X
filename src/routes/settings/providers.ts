import type { RouteHandler } from "../../server-context.js";
import { jsonResponse, readBody } from "../../server-utils.js";
import { getRuntimeConfig } from "../../config.js";
import { loadSettings, saveSettings } from "../../settings.js";
import { isEmbeddingModel } from "../../canonical-loop/public/op-facts.js";
import type { ProviderId } from "../../providers/provider-ids.js";
import { PROVIDERS } from "../../providers/registry.js";
import {
  refreshCloudOllama,
  getCachedCloudModels,
  fetchLocalOllamaTags,
} from "../../ollama-cloud.js";
import {
  getLocalRuntimes,
  localRuntimesStale,
  refreshLocalRuntimes,
  invalidateLocalRuntimes,
  manualRuntimeEntries,
  endpointHostPort,
  lmStudioAutoStartedAt,
  certifyLocalModel,
  hasPublishedCertification,
  type LocalModelCertification,
  type LocalRuntimeInfo,
} from "../../local-runtimes/index.js";
import { isLocalOnlyMode, localProviderDecision, LOCAL_ONLY_BLOCK_MESSAGE } from "../../local-only-policy.js";

function modelsWithCertification(runtime: LocalRuntimeInfo) {
  return runtime.models.map((model) => ({
    ...model,
    certification: {
      status: hasPublishedCertification(runtime, model) ? "verified" as const : "unverified" as const,
    },
  }));
}

function certificationResponse(runtime: LocalRuntimeInfo, modelId: string, result: LocalModelCertification) {
  const model = runtime.models.find((candidate) => candidate.id === modelId);
  const verified = !!model && hasPublishedCertification(runtime, model);
  const status = !result.fingerprint.reusable
    ? "identity_unavailable" as const
    : verified ? "verified" as const : "failed" as const;
  return {
    ok: verified,
    status,
    passedCount: result.passedCount,
    scenarioCount: Object.keys(result.scenarios).length,
    callCount: result.callCount,
    totalLatencyMs: result.totalLatencyMs,
    scenarios: Object.entries(result.scenarios).map(([id, scenario]) => ({
      id, passed: scenario.passed, calls: scenario.calls,
      latencyMs: scenario.latencyMs, failure: scenario.failure,
    })),
  };
}

export const handleProvidersRoutes: RouteHandler = async (method, url, req, res, ctx, _role) => {
  const json = (status: number, data: unknown) => jsonResponse(res, status, data, req);

  // Providers
  if (method === "GET" && url.pathname === "/api/providers") {
    const { loadTokens } = await import("../../auth/index.js");
    const { loadAnthropicTokens, isAnthropicCliAuthenticated } = await import("../../auth/anthropic.js");
    const { loadXaiTokens } = await import("../../auth/xai.js");
    const providers: Array<{
      id: string; name: string; models: string[]; active: boolean;
      runtimes?: Array<{
        id: string; label: string; kind: string; origin: string; baseUrl: string;
        models: Array<{ id: string; contextWindow: number | null; tools: boolean | null;
          certification: { status: "verified" | "unverified" } }>;
      }>;
    }> = [];
    const localOnly = isLocalOnlyMode();
    const hasOpenAIOAuth = !localOnly && !!loadTokens();
    // Count BOTH our setup-token store (~/.lax) and the CLI's own credential
    // file (~/.claude) — the paste-the-code sign-in writes the latter, and the
    // chat subprocess authenticates from it. Without the CLI check a CLI-signed
    // user is "Connected" in Settings but missing from this picker.
    const hasAnthropicOAuth = !localOnly && (!!loadAnthropicTokens() || isAnthropicCliAuthenticated());
    const hasXaiOAuth = !localOnly && !!loadXaiTokens();
    const hasXaiKey = ctx.secretsStore.has("XAI_API_KEY") || hasXaiOAuth;
    const hasCerebrasKey = ctx.secretsStore.has("CEREBRAS_API_KEY");
    const hasOpenAIKey = !!ctx.config.openaiApiKey || ctx.secretsStore.has("OPENAI_API_KEY");
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
      else if (hasOpenAIOAuth) currentProvider = "codex";
      // No `else` — leave empty so the renderer knows the user needs to
      // pick + connect a provider before they're considered onboarded.
    }
    if (!currentModel && currentProvider) {
      const reg = PROVIDERS[currentProvider as ProviderId];
      if (reg?.defaultModel) currentModel = reg.defaultModel;
    }
    const hasGeminiKey = ctx.secretsStore.has("GEMINI_API_KEY");
    const hasCustomKey = ctx.secretsStore.has("CUSTOM_API_KEY");
    // Provider list, labels, and model arrays derived from PROVIDERS so
    // adding a provider only requires editing registry.ts.
    const pushFromRegistry = (id: ProviderId) =>
      providers.push({ id, name: PROVIDERS[id].label, models: [...PROVIDERS[id].models], active: currentProvider === id });
    if (hasXaiKey && !localOnly) pushFromRegistry("xai");
    if (hasGeminiKey && !localOnly) pushFromRegistry("gemini");
    if (hasCerebrasKey && !localOnly) pushFromRegistry("cerebras");
    if (hasOpenAIOAuth && !localOnly) pushFromRegistry("codex");
    if (hasAnthropicOAuth && !localOnly) pushFromRegistry("anthropic");
    if (hasOpenAIKey && !localOnly) pushFromRegistry("openai");
    // Local runtimes (Ollama, LM Studio, vLLM, llama.cpp, manual adds) —
    // ONE picker entry whose models are the union across discovered
    // runtimes. Read from the local-runtimes cache (warmed at boot,
    // re-swept every 60s) — never a live probe on this path. The
    // `runtimes` sibling carries per-runtime detail for the settings UI;
    // the flat `models` array keeps the existing renderer working as-is.
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
    // Gemini before keys are added).
    if (!localOnly) {
      const hasCloudKey = ctx.secretsStore.has("OLLAMA_CLOUD_API_KEY");
      // Read cloud models from cache — NEVER an inline ollama.com round-trip
      // here. That internet call (only present when a cloud key is set) was
      // the machine-specific 5s stall on the provider-list path. If a key is
      // set but the cache is cold, kick a background refresh and return what
      // we have; bootstrap-services warms it at startup.
      let cloudModels: string[] = [];
      if (hasCloudKey) {
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
    if (provider === "openai") {
      const hasOpenAIKey = !!(ctx.config.openaiApiKey || ctx.secretsStore.has("OPENAI_API_KEY"));
      if (!hasOpenAIKey) {
        try {
          const { loadTokens } = await import("../../auth/index.js");
          if (loadTokens()) { provider = "codex"; model = model || "gpt-5.4"; }
        } catch {}
      }
    }

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

  // Static provider registry — labels + model lists, no creds gating.
  // Lets the Apps gallery dropdown render every provider without
  // re-hardcoding the metadata client-side.
  if (method === "GET" && url.pathname === "/api/providers/registry") {
    const customBaseUrl = String(loadSettings().customBaseUrl || "");
    const out = (Object.keys(PROVIDERS) as ProviderId[])
      .filter(id => localProviderDecision(id, getRuntimeConfig(), customBaseUrl).allowed)
      .map(id => ({
      id,
      label: PROVIDERS[id].label,
      models: PROVIDERS[id].models,
      defaultModel: PROVIDERS[id].defaultModel,
      transport: PROVIDERS[id].transport,
    }));
    json(200, { providers: out, localOnlyMode: isLocalOnlyMode() });
    return true;
  }

  // Local models — chat-capable only (embedding models filtered out).
  // Pass `?include=embeddings` to get the full list (e.g. for an
  // embedding-provider settings page).
  if (method === "GET" && url.pathname === "/api/models/local") {
    const { reachable, models: all } = await fetchLocalOllamaTags(getRuntimeConfig().ollamaUrl);
    if (!reachable) { json(502, { error: "Ollama not running. Start it with: ollama serve" }); return true; }
    const includeEmbeddings = url.searchParams.get("include") === "embeddings";
    const filtered = includeEmbeddings ? all : all.filter(m => !isEmbeddingModel(m.name));
    json(200, { models: filtered.map(m => ({ name: m.name, size: m.size, modified: m.modified_at })) });
    return true;
  }
  // Test the Ollama Cloud connection. Used by the settings UI's "Connect"
  // button: user pastes the API key (which the UI saves as the
  // OLLAMA_CLOUD_API_KEY secret first), then we attempt a model-list
  // fetch to confirm reachability. Returns the model count so the UI
  // can render "Connected · N models".
  if (method === "POST" && url.pathname === "/api/ollama/test-cloud") {
    try {
      const { refreshCloudOllama, invalidateCloudOllamaCache } = await import("../../ollama-cloud.js");
      invalidateCloudOllamaCache();
      const r = await refreshCloudOllama(ctx.secretsStore, getRuntimeConfig().ollamaCloudUrl);
      if (r.reachable) {
        json(200, { ok: true, modelCount: r.models.length, models: r.models });
      } else {
        json(200, { ok: false, error: r.error || "unreachable" });
      }
    } catch (e: unknown) {
      json(500, { ok: false, error: e instanceof Error ? e.message : String(e) });
    }
    return true;
  }
  // Manual local-runtime registration (LM Studio on a custom port, a GPU
  // box, etc.). The entry itself IS the admission-gate allowlist entry —
  // exact host:port, no ranges. Non-loopback adds are refused in strict
  // local-only mode (they would widen the nothing-leaves-this-box promise).
  if (method === "GET" && url.pathname === "/api/local-runtimes") {
    const runtimes = getLocalRuntimes();
    if (localRuntimesStale()) void refreshLocalRuntimes().catch(() => {});
    json(200, {
      runtimes: (runtimes ?? []).map((runtime) => ({
        ...runtime,
        models: modelsWithCertification(runtime),
      })),
      manual: manualRuntimeEntries(),
      // Epoch ms when LAX flipped LM Studio's API server on this process
      // lifetime (null = never). Lets the UI label the runtime honestly.
      lmStudioAutoStartedAt: lmStudioAutoStartedAt(),
    });
    return true;
  }
  if (method === "POST" && url.pathname === "/api/local-runtimes/certify") {
    if (_role !== "operator") {
      json(403, { ok: false, error: "Operator access required" });
      return true;
    }
    let body: Record<string, unknown>;
    try { body = JSON.parse(await readBody(req)); } catch { json(400, { ok: false, error: "Invalid JSON" }); return true; }
    const runtimeId = typeof body.runtimeId === "string" ? body.runtimeId : "";
    const modelId = typeof body.model === "string" ? body.model : "";
    if (!runtimeId || !modelId) {
      json(400, { ok: false, error: "runtimeId and model are required" });
      return true;
    }
    const runtime = getLocalRuntimes()?.find((candidate) => candidate.id === runtimeId);
    if (!runtime) {
      json(404, { ok: false, error: "Local runtime not found" });
      return true;
    }
    if (!runtime.models.some((candidate) => candidate.id === modelId)) {
      json(404, { ok: false, error: "Local model not found" });
      return true;
    }
    try {
      const result = await certifyLocalModel({ runtime, model: modelId });
      json(200, certificationResponse(runtime, modelId, result));
    } catch {
      json(500, { ok: false, status: "error", error: "Verification failed" });
    }
    return true;
  }
  if (method === "POST" && url.pathname === "/api/local-runtimes") {
    let body: Record<string, unknown>;
    try { body = JSON.parse(await readBody(req)); } catch { json(400, { error: "Invalid JSON" }); return true; }
    const kind = String(body.kind || "");
    const baseUrl = String(body.baseUrl || "").replace(/\/+$/, "");
    const label = typeof body.label === "string" && body.label.length > 0 ? body.label : undefined;
    if (kind !== "ollama" && kind !== "openai-compat") { json(400, { error: "kind must be ollama | openai-compat" }); return true; }
    const hostPort = endpointHostPort(baseUrl);
    if (!hostPort) { json(400, { error: "baseUrl must be a valid http(s) URL" }); return true; }
    const { isLoopbackUrl } = await import("../../local-only-policy.js");
    if (isLocalOnlyMode() && !isLoopbackUrl(baseUrl)) {
      json(403, { error: LOCAL_ONLY_BLOCK_MESSAGE, code: "LOCAL_ONLY" });
      return true;
    }
    const settings = { ...loadSettings() };
    const existing = manualRuntimeEntries(settings);
    if (existing.some(e => endpointHostPort(e.baseUrl) === hostPort)) {
      json(409, { error: `a runtime at ${hostPort} is already registered` });
      return true;
    }
    settings.localRuntimes = [...existing, { kind, baseUrl, ...(label ? { label } : {}) }];
    saveSettings(settings);
    invalidateLocalRuntimes();
    const runtimes = await refreshLocalRuntimes().catch(() => []);
    const added = runtimes.find(r => r.endpoint.baseUrl === baseUrl) ?? null;
    json(200, { ok: true, reachable: added !== null, runtime: added });
    return true;
  }
  if (method === "DELETE" && url.pathname === "/api/local-runtimes") {
    const hostPort = endpointHostPort(String(url.searchParams.get("baseUrl") || ""));
    if (!hostPort) { json(400, { error: "baseUrl query param required" }); return true; }
    const settings = { ...loadSettings() };
    const remaining = manualRuntimeEntries(settings).filter(e => endpointHostPort(e.baseUrl) !== hostPort);
    settings.localRuntimes = remaining;
    saveSettings(settings);
    invalidateLocalRuntimes();
    void refreshLocalRuntimes().catch(() => {});
    json(200, { ok: true });
    return true;
  }

  if (method === "POST" && url.pathname === "/api/ollama/start") {
    try {
      const { spawn } = await import("node:child_process");
      const child = spawn("ollama", ["serve"], { detached: true, stdio: "ignore", windowsHide: true });
      child.unref();
      json(200, { ok: true, message: "Ollama starting..." });
    } catch (e: unknown) { json(500, { error: "Failed to start Ollama: " + (e instanceof Error ? e.message : String(e)) }); }
    return true;
  }

  return false;
};
