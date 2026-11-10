/**
 * A chat's own model (ADR 0007 §8, session/model-pin.ts), as the provider
 * picker reads and sets it.
 *
 *   GET  /api/providers?session=<id>  — `current` is that chat's model when it
 *        has one (`pinned: true`), `default` is what a chat with none runs on.
 *   POST /api/providers/session-model  {sessionId, provider, model?, effort?}
 *        sets it; {sessionId, clear: true} puts the chat back on the default.
 *
 * `POST /api/providers/switch` still sets the default, which every chat with
 * no model of its own follows.
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import { jsonResponse, readBody } from "../../server-utils.js";
import { getRuntimeConfig } from "../../config.js";
import { loadSettings, saveSettings } from "../../settings.js";
import { PROVIDERS } from "../../providers/registry.js";
import type { ProviderId } from "../../providers/provider-ids.js";
import { normalizeReasoningEffort, type ReasoningEffort } from "../../providers/reasoning-effort.js";
import { localProviderDecision, LOCAL_ONLY_BLOCK_MESSAGE } from "../../local-only-policy.js";
import { isPinnableSessionId, parseModelPin, sessionModelPins } from "../../session/model-pin.js";

export interface ChatModelView {
  provider: string;
  model: string;
  effort: ReasoningEffort;
  /** True when this is the chat's own choice, not the default. */
  pinned: boolean;
}

function pinAllowed(provider: string): boolean {
  return localProviderDecision(provider, getRuntimeConfig(), String(loadSettings().customBaseUrl || "")).allowed;
}

/** What the picker shows for `sessionId`, given the default it resolved. */
export function chatModelChoice(
  sessionId: string | null,
  fallback: { provider: string; model: string },
): { current: ChatModelView; default: ChatModelView } {
  const def: ChatModelView = { ...fallback, effort: normalizeReasoningEffort(loadSettings().reasoningEffort), pinned: false };
  const pin = sessionId && isPinnableSessionId(sessionId) ? sessionModelPins().get(sessionId) : null;
  // A pin the policy no longer allows (local-only turned on) is not shown as
  // the chat's model: the turn would not run on it either.
  if (!pin || !pinAllowed(pin.provider)) return { current: def, default: def };
  const current: ChatModelView = {
    provider: pin.provider,
    model: pin.model || PROVIDERS[pin.provider]?.defaultModel || "",
    effort: pin.effort ?? def.effort,
    pinned: true,
  };
  return { current, default: def };
}

export async function handleSessionModelRoute(
  method: string,
  url: URL,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<boolean> {
  if (method !== "POST" || url.pathname !== "/api/providers/session-model") return false;
  const json = (status: number, data: unknown) => jsonResponse(res, status, data, req);
  let body: Record<string, unknown>;
  try { body = JSON.parse(await readBody(req)); } catch { json(400, { error: "Invalid JSON" }); return true; }
  if (!body || typeof body !== "object") { json(400, { error: "Invalid JSON" }); return true; }
  const sessionId = body.sessionId;
  if (!isPinnableSessionId(sessionId)) { json(400, { error: "sessionId required" }); return true; }

  let sessionModel: { sessionId: string; provider: string | null; model: string | null; effort: string | null };
  if (body.clear === true) {
    sessionModelPins().clear(sessionId);
    sessionModel = { sessionId, provider: null, model: null, effort: null };
  } else {
    const parsed = parseModelPin(body);
    if ("error" in parsed) { json(400, { error: parsed.error }); return true; }
    if (!pinAllowed(parsed.pin.provider)) { json(403, { error: LOCAL_ONLY_BLOCK_MESSAGE, code: "LOCAL_ONLY" }); return true; }
    const saved = sessionModelPins().set(sessionId, parsed.pin);
    sessionModel = { sessionId, provider: saved.provider, model: saved.model, effort: saved.effort ?? null };
  }
  // Every open tab redraws the picker of the chat it shows, if it is this one.
  try {
    const { broadcastAll } = await import("../../chat-ws/index.js");
    broadcastAll({ type: "settings_changed", settings: { sessionModel } });
  } catch { /* no socket server in tests */ }
  json(200, { ok: true, ...sessionModel });
  return true;
}

/** POST /api/providers/switch: the default model, which every chat with no
 *  model of its own follows and every new chat starts on. */
export async function handleDefaultModelRoute(
  method: string,
  url: URL,
  req: IncomingMessage,
  res: ServerResponse,
  hasCreds: (id: ProviderId) => boolean,
): Promise<boolean> {
  if (method !== "POST" || url.pathname !== "/api/providers/switch") return false;
  const json = (status: number, data: unknown) => jsonResponse(res, status, data, req);
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
  if (provider === "openai" && !hasCreds("openai") && hasCreds("codex")) { provider = "codex"; model = model || PROVIDERS.codex.defaultModel; }

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
  } catch { /* no socket server in tests */ }
  json(200, { ok: true, provider, model: model || settings.model }); return true;
}
