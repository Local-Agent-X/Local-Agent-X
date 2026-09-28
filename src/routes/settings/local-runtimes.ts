// Local runtime + Ollama routes: the discovered-runtime list, manual runtime
// registration, model certification, the local Ollama tag list, the Ollama
// Turbo connection test and the `ollama serve` launcher. Split out of
// providers.ts (which keeps the picker's provider list and the switch) at the
// 400-LOC gate; providers.ts delegates here for anything it does not handle.
import type { RouteHandler } from "../../server-context.js";
import { jsonResponse, readBody } from "../../server-utils.js";
import { getRuntimeConfig } from "../../config.js";
import { loadSettings, saveSettings } from "../../settings.js";
import { isEmbeddingModel } from "../../canonical-loop/public/op-facts.js";
import { fetchLocalOllamaTags } from "../../ollama-cloud.js";
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
import { isLocalOnlyMode, LOCAL_ONLY_BLOCK_MESSAGE } from "../../local-only-policy.js";

export function modelsWithCertification(runtime: LocalRuntimeInfo) {
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
    ok: verified, status, target: { runtimeId: runtime.id, model: modelId },
    identityEvidence: result.fingerprint.reusable ? "runtime_version_and_model_digest" : "unavailable",
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

export const handleLocalRuntimesRoutes: RouteHandler = async (method, url, req, res, ctx, _role) => {
  const json = (status: number, data: unknown) => jsonResponse(res, status, data, req);

  // Local models — chat-capable only (embedding models filtered out).
  // Pass `?include=embeddings` to get the full list (e.g. for an
  // embedding-provider settings page).
  if (method === "GET" && url.pathname === "/api/models/local") {
    const { reachable, models: all } = await fetchLocalOllamaTags(getRuntimeConfig().ollamaUrl);
    if (!reachable) { json(502, { error: "Ollama not running. Start it with: ollama serve" }); return true; }
    const includeEmbeddings = url.searchParams.get("include") === "embeddings";
    const filtered = includeEmbeddings ? all : all.filter(m => !m.embeddingOnly && !isEmbeddingModel(m.name));
    json(200, { models: filtered.map(m => ({ name: m.name, size: m.size, modified: m.modified_at, ...(m.embeddingOnly ? { embeddingOnly: true } : {}) })) });
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
    if (_role !== "operator") { json(403, { error: "Operator access required" }); return true; }
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
    if (_role !== "operator") { json(403, { error: "Operator access required" }); return true; }
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
    if (_role !== "operator") { json(403, { error: "Operator access required" }); return true; }
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
