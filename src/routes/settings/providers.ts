import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { RouteHandler } from "../../server-context.js";
import { jsonResponse, readBody } from "../../server-utils.js";
import { getRuntimeConfig } from "../../config.js";
import { isEmbeddingModel } from "../../canonical-loop/model-capabilities.js";
import type { ProviderId } from "../../providers/provider-ids.js";
import { PROVIDERS } from "../../providers/registry.js";

export const handleProvidersRoutes: RouteHandler = async (method, url, req, res, ctx, _role) => {
  const json = (status: number, data: unknown) => jsonResponse(res, status, data, req);

  // Providers
  if (method === "GET" && url.pathname === "/api/providers") {
    const { loadTokens } = await import("../../auth.js");
    const { loadAnthropicTokens } = await import("../../auth-anthropic.js");
    const { loadXaiTokens } = await import("../../auth-xai.js");
    const providers: Array<{ id: string; name: string; models: string[]; active: boolean }> = [];
    const hasOpenAIOAuth = !!loadTokens();
    const hasAnthropicOAuth = !!loadAnthropicTokens();
    const hasXaiOAuth = !!loadXaiTokens();
    const hasXaiKey = ctx.secretsStore.has("XAI_API_KEY") || hasXaiOAuth;
    const hasCerebrasKey = ctx.secretsStore.has("CEREBRAS_API_KEY");
    const hasOpenAIKey = !!ctx.config.openaiApiKey || ctx.secretsStore.has("OPENAI_API_KEY");
    let hasOllama = false;
    const ollamaUrl = getRuntimeConfig().ollamaUrl;
    try { const r = await fetch(`${ollamaUrl}/api/tags`, { signal: AbortSignal.timeout(2000) }); hasOllama = r.ok; } catch {}
    // Resolve current provider/model the same way the request path does
    // (see src/agent-request/resolve-provider.ts). The previous default
    // hardcoded "xai"/"grok-4" here regardless of which creds were
    // actually present; after the install stopped seeding settings.provider
    // (commit 4c9e5c4), every fresh install with no xAI key got a phantom
    // current.provider="xai" the UI couldn't render. Mirror the request-
    // resolution logic so the dropdown reflects what would actually run.
    let currentProvider = "", currentModel = "";
    try {
      const sp = join(ctx.dataDir, "settings.json");
      if (existsSync(sp)) {
        const s = JSON.parse(readFileSync(sp, "utf-8"));
        if (s.provider) currentProvider = String(s.provider);
        if (s.model) currentModel = String(s.model);
      }
    } catch {}
    if (!currentProvider) {
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
    if (hasXaiKey) pushFromRegistry("xai");
    if (hasGeminiKey) pushFromRegistry("gemini");
    if (hasCerebrasKey) pushFromRegistry("cerebras");
    if (hasOpenAIOAuth) pushFromRegistry("codex");
    if (hasAnthropicOAuth) pushFromRegistry("anthropic");
    if (hasOpenAIKey) pushFromRegistry("openai");
    if (hasOllama) {
      let ollamaModels: string[] = [];
      try {
        const r = await fetch(`${ollamaUrl}/api/tags`, { signal: AbortSignal.timeout(3000) });
        const d = await r.json() as { models?: Array<{ name: string }> };
        // Filter out embedding-only models — they can't serve chat
        // completions and showing them in the chat-model picker leads
        // to confusing runtime errors.
        ollamaModels = (d.models || []).map(m => m.name).filter(n => !isEmbeddingModel(n));
      } catch {}
      providers.push({ id: "local", name: "Ollama", models: ollamaModels, active: currentProvider === "local" });
    }
    // Ollama Turbo (cloud) — separate top-level entry so users find it
    // by name in the dropdown. When the API key isn't set yet, we still
    // surface the provider with an empty model list so the picker shows
    // the option (and the connect-key field appears, same UX as xAI/
    // Gemini before keys are added).
    {
      const hasCloudKey = ctx.secretsStore.has("OLLAMA_CLOUD_API_KEY");
      let cloudModels: string[] = [];
      if (hasCloudKey) {
        try {
          const { refreshCloudOllama } = await import("../../ollama-cloud.js");
          const r = await refreshCloudOllama(ctx.secretsStore, getRuntimeConfig().ollamaCloudUrl);
          cloudModels = r.models;
        } catch { /* cloud unreachable; surface empty list */ }
      }
      providers.push({
        id: "ollama-cloud",
        name: PROVIDERS["ollama-cloud"].label,
        models: cloudModels,
        active: currentProvider === "ollama-cloud",
      });
    }
    if (hasCustomKey) pushFromRegistry("custom");
    json(200, { providers, current: { provider: currentProvider, model: currentModel } }); return true;
  }

  // Switch provider
  if (method === "POST" && url.pathname === "/api/providers/switch") {
    let body: Record<string, unknown>;
    try { body = JSON.parse(await readBody(req)); } catch { json(400, { error: "Invalid JSON" }); return true; }
    let provider = String(body.provider || "");
    let model = String(body.model || "");
    if (!provider) { json(400, { error: "provider required" }); return true; }

    // Alias: if the user (or agent) asks for "openai" but only OAuth-based
    // Codex is configured, route to codex. Avoids saving a broken
    // provider=openai/model=gpt-5.4 config that dies on every turn.
    if (provider === "openai") {
      const hasOpenAIKey = !!(ctx.config.openaiApiKey || ctx.secretsStore.has("OPENAI_API_KEY"));
      if (!hasOpenAIKey) {
        try {
          const { loadTokens } = await import("../../auth.js");
          if (loadTokens()) { provider = "codex"; model = model || "gpt-5.4"; }
        } catch {}
      }
    }

    const settingsPath = join(ctx.dataDir, "settings.json");
    let settings: Record<string, unknown> = {};
    try { if (existsSync(settingsPath)) settings = JSON.parse(readFileSync(settingsPath, "utf-8")); } catch {}
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
    writeFileSync(settingsPath, JSON.stringify(settings, null, 2));
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
    const out = (Object.keys(PROVIDERS) as ProviderId[]).map(id => ({
      id,
      label: PROVIDERS[id].label,
      models: PROVIDERS[id].models,
      defaultModel: PROVIDERS[id].defaultModel,
      transport: PROVIDERS[id].transport,
    }));
    json(200, { providers: out });
    return true;
  }

  // Local models — chat-capable only (embedding models filtered out).
  // Pass `?include=embeddings` to get the full list (e.g. for an
  // embedding-provider settings page).
  if (method === "GET" && url.pathname === "/api/models/local") {
    try {
      const ollamaRes = await fetch(`${getRuntimeConfig().ollamaUrl}/api/tags`, { signal: AbortSignal.timeout(3000) });
      if (!ollamaRes.ok) { json(502, { error: "Ollama returned " + ollamaRes.status }); return true; }
      const data = await ollamaRes.json() as { models?: Array<{ name: string; size: number; modified_at: string }> };
      const all = data.models || [];
      const includeEmbeddings = url.searchParams.get("include") === "embeddings";
      const filtered = includeEmbeddings ? all : all.filter(m => !isEmbeddingModel(m.name));
      json(200, { models: filtered.map(m => ({ name: m.name, size: m.size, modified: m.modified_at })) });
    } catch { json(502, { error: "Ollama not running. Start it with: ollama serve" }); }
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
