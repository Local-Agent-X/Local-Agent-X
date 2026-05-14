import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { RouteHandler } from "../../server-context.js";
import { jsonResponse, readBody } from "../../server-utils.js";
import { getRuntimeConfig } from "../../config.js";
import { isEmbeddingModel } from "../../canonical-loop/model-capabilities.js";
import type { ProviderId } from "../../providers/provider-ids.js";

export const handleProvidersRoutes: RouteHandler = async (method, url, req, res, ctx, _role) => {
  const json = (status: number, data: unknown) => jsonResponse(res, status, data, req);

  // Providers
  if (method === "GET" && url.pathname === "/api/providers") {
    const { loadTokens } = await import("../../auth.js");
    const { loadAnthropicTokens } = await import("../../auth-anthropic.js");
    const providers: Array<{ id: string; name: string; models: string[]; active: boolean }> = [];
    const hasOpenAIOAuth = !!loadTokens();
    const hasAnthropicOAuth = !!loadAnthropicTokens();
    const hasXaiKey = ctx.secretsStore.has("XAI_API_KEY");
    const hasCerebrasKey = ctx.secretsStore.has("CEREBRAS_API_KEY");
    const hasOpenAIKey = !!ctx.config.openaiApiKey || ctx.secretsStore.has("OPENAI_API_KEY");
    let hasOllama = false;
    const ollamaUrl = getRuntimeConfig().ollamaUrl;
    try { const r = await fetch(`${ollamaUrl}/api/tags`, { signal: AbortSignal.timeout(2000) }); hasOllama = r.ok; } catch {}
    let currentProvider = "xai", currentModel = "grok-4";
    try { const sp = join(ctx.dataDir, "settings.json"); if (existsSync(sp)) { const s = JSON.parse(readFileSync(sp, "utf-8")); currentProvider = s.provider || "xai"; currentModel = s.model || ""; } } catch {}
    const hasGeminiKey = ctx.secretsStore.has("GEMINI_API_KEY");
    const hasCustomKey = ctx.secretsStore.has("CUSTOM_API_KEY");
    if (hasXaiKey) providers.push({ id: "xai", name: "xAI Grok", models: ["grok-4", "grok-3", "grok-3-mini"], active: currentProvider === "xai" });
    if (hasGeminiKey) providers.push({ id: "gemini", name: "Google Gemini", models: ["gemini-2.0-flash", "gemini-2.5-pro-preview-05-06", "gemini-2.5-flash-preview-05-20"], active: currentProvider === "gemini" });
    if (hasCerebrasKey) providers.push({ id: "cerebras", name: "Cerebras", models: ["gpt-oss-120b", "zai-glm-4.7"], active: currentProvider === "cerebras" });
    if (hasOpenAIOAuth) providers.push({ id: "codex", name: "OpenAI Codex", models: ["gpt-5.5", "gpt-5.4", "gpt-5.4-mini", "gpt-5.3-codex"], active: currentProvider === "codex" });
    if (hasAnthropicOAuth) providers.push({ id: "anthropic", name: "Anthropic", models: ["claude-opus-4-7", "claude-sonnet-4-6", "claude-opus-4-6", "claude-haiku-4-5", "claude-sonnet-4-5", "claude-opus-4-5"], active: currentProvider === "anthropic" });
    if (hasOpenAIKey) providers.push({ id: "openai", name: "OpenAI API", models: ["gpt-4o", "gpt-4o-mini", "o3-pro"], active: currentProvider === "openai" });
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
        name: "Ollama Turbo (cloud)",
        models: cloudModels,
        active: currentProvider === "ollama-cloud",
      });
    }
    if (hasCustomKey) providers.push({ id: "custom", name: "Custom Provider", models: ["custom-model"], active: currentProvider === "custom" });
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
      // Pick the BEST available model for each provider — when the agent
      // switches providers without specifying a model, it should go flagship,
      // not cheap/fast.
      const DEFAULT_MODEL: Record<ProviderId, string> = {
        xai: "grok-4",
        openai: "o3-pro",
        codex: "gpt-5.4",
        anthropic: "claude-opus-4-7",
        gemini: "gemini-2.5-pro-preview-05-06",
        cerebras: "gpt-oss-120b",
        local: "qwen2:7b",
        "ollama-cloud": "",  // user picks from cloud catalog; no sane default
        custom: "custom-model",
      };
      model = DEFAULT_MODEL[provider as ProviderId] || String(settings.model || "");
    }
    settings.provider = provider;
    if (model) settings.model = model;
    writeFileSync(settingsPath, JSON.stringify(settings, null, 2));
    // Broadcast so every open browser tab (bottom status bar, model selector)
    // updates instantly instead of staying on the stale provider.
    try {
      const { broadcastAll } = await import("../../chat-ws.js");
      broadcastAll({ type: "settings_changed", settings: { provider, model } });
    } catch {}
    json(200, { ok: true, provider, model: model || settings.model }); return true;
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
