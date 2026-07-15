/**
 * OpenAI-compat adapter for the local-runtime seam — the SECOND adapter.
 * Covers every local server that speaks `/v1/models` + `/v1/chat/completions`:
 * LM Studio, vLLM, llama.cpp server, and anything else OpenAI-shaped.
 *
 * Wire facts (LM Studio 0.3.x verified live 2026-07-15; others documented):
 *   /v1/models          → {"object":"list","data":[{"id":...}]} — bare on
 *                         LM Studio; vLLM adds max_model_len per entry.
 *   /api/v0/models      → LM Studio enhancement: max_context_length,
 *                         loaded_context_length, state, capabilities
 *                         ["tool_use"], quantization. Used opportunistically.
 *   /props              → llama.cpp server: default_generation_settings
 *                         .n_ctx = the SERVED context. Used opportunistically.
 *
 * Window honesty: vLLM's max_model_len and llama.cpp's n_ctx ARE the served
 * window (fixed at server launch). LM Studio's max_context_length is the
 * model's MAX, not what a load will serve — so only loaded_context_length
 * (state=loaded) is reported; unloaded models stay unknown until the sweep
 * after they load. Unknown is never papered over with a guess.
 *
 * NOTE: Ollama also serves /v1/models, so this probe must run AFTER the
 * ollama probe in LOCAL_RUNTIME_PROBES — first detect() claims the endpoint.
 */
import type {
  LocalModel,
  LocalRuntimeEndpoint,
  LocalRuntimeProbe,
} from "./types.js";

const DETECT_TIMEOUT_MS = 1_500;
const LIST_TIMEOUT_MS = 4_000;

function base(ep: LocalRuntimeEndpoint): string {
  return ep.baseUrl.replace(/\/+$/, "");
}

async function getJson(
  url: string,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<Record<string, unknown> | null> {
  try {
    const r = await fetch(url, {
      redirect: "manual",
      signal: signal ?? AbortSignal.timeout(timeoutMs),
    });
    if (!r.ok) return null;
    const data: unknown = await r.json();
    return data && typeof data === "object" ? (data as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function posInt(v: unknown): number | null {
  const n = Number(v);
  return Number.isInteger(n) && n > 0 ? n : null;
}

interface RawEntry {
  id?: unknown;
  /** LM Studio /api/v0: "llm" | "vlm" | "embeddings". Absent on bare /v1. */
  type?: unknown;
  /** vLLM: the served window. */
  max_model_len?: unknown;
  /** LM Studio /api/v0: model max — NOT the served window. */
  max_context_length?: unknown;
  /** LM Studio /api/v0: the served window, present when loaded. */
  loaded_context_length?: unknown;
  state?: unknown;
  capabilities?: unknown;
}

/** Map one model-list entry to a LocalModel. Exported for tests. */
export function entryToModel(raw: unknown): LocalModel | null {
  if (!raw || typeof raw !== "object") return null;
  const e = raw as RawEntry;
  if (typeof e.id !== "string" || e.id.length === 0) return null;
  // This seam serves the CHAT picker. When the runtime declares the model
  // type authoritatively (LM Studio /api/v0), drop embeddings models here
  // rather than leaning on the downstream name-regex (isEmbeddingModel),
  // which is a heuristic backstop for runtimes that won't say.
  if (e.type === "embeddings") return null;
  // Served-window sources only; LM Studio's max_context_length is
  // deliberately ignored (it's a ceiling, not the loaded reality).
  const loaded = e.state === "loaded" ? posInt(e.loaded_context_length) : null;
  const contextWindow = loaded ?? posInt(e.max_model_len);
  const tools = Array.isArray(e.capabilities) ? e.capabilities.includes("tool_use") : null;
  return { id: e.id, contextWindow, tools };
}

function listFrom(data: Record<string, unknown> | null): unknown[] | null {
  if (!data || !Array.isArray(data.data)) return null;
  return data.data;
}

export const openaiCompatProbe: LocalRuntimeProbe = {
  kind: "openai-compat",
  label: "OpenAI-compatible",
  // LM Studio 1234, vLLM 8000, llama.cpp 8080, Jan 1337, GPT4All 4891,
  // text-generation-webui 5000, KoboldCpp 5001. 11434 is claimed by the
  // ollama probe first (probe order in probes.ts is load-bearing).
  // Growing this list is discovery-only: agent egress derives from
  // DISCOVERED runtimes (localRuntimeLoopbackPorts), never from these
  // candidates — so common dev ports like 5000 are safe to sweep.
  defaultPorts: [1234, 1337, 4891, 5000, 5001, 8000, 8080],

  async detect(ep, signal) {
    return listFrom(await getJson(`${base(ep)}/v1/models`, DETECT_TIMEOUT_MS, signal)) !== null;
  },

  async identify(ep, signal) {
    // LM Studio is the only server with /api/v0/models; llama.cpp the only
    // one with /props. Both checks are cheap loopback GETs.
    if (listFrom(await getJson(`${base(ep)}/api/v0/models`, DETECT_TIMEOUT_MS, signal))) {
      return "LM Studio";
    }
    const props = await getJson(`${base(ep)}/props`, DETECT_TIMEOUT_MS, signal);
    if (props && "default_generation_settings" in props) return "llama.cpp";
    return null;
  },

  async listModels(ep, signal) {
    // Prefer LM Studio's enhanced listing; fall back to bare /v1/models.
    const enhanced = listFrom(await getJson(`${base(ep)}/api/v0/models`, LIST_TIMEOUT_MS, signal));
    const entries = enhanced ?? listFrom(await getJson(`${base(ep)}/v1/models`, LIST_TIMEOUT_MS, signal));
    if (!entries) return [];
    const out: LocalModel[] = [];
    for (const raw of entries) {
      const m = entryToModel(raw);
      if (m) out.push(m);
    }
    return out;
  },

  async probeModel(ep, modelId, signal) {
    // llama.cpp: /props carries the server-wide served context.
    const props = await getJson(`${base(ep)}/props`, DETECT_TIMEOUT_MS, signal);
    const settings = props?.default_generation_settings as { n_ctx?: unknown } | undefined;
    const nCtx = posInt(settings?.n_ctx);
    if (nCtx !== null) return { contextWindow: nCtx };
    // Otherwise everything knowable came from listModels already.
    const models = await this.listModels(ep, signal);
    const m = models.find((x) => x.id === modelId);
    if (!m) return {};
    const out: Partial<LocalModel> = {};
    if (m.contextWindow !== null) out.contextWindow = m.contextWindow;
    if (m.tools !== null) out.tools = m.tools;
    return out;
  },

  chatExtraBody() {
    // No surveyed runtime honors a per-request context-size field on /v1;
    // context is load/launch-time config everywhere. Never ship a no-op param.
    return {};
  },
};
