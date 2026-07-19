/**
 * OpenAI-compat adapter for the local-runtime seam — the SECOND adapter.
 * Covers every local server that speaks `/v1/models` + `/v1/chat/completions`:
 * LM Studio, vLLM, llama.cpp server, LocalAI, LiteLLM proxy, Xinference,
 * Lemonade, TGI, llamafile, and anything else OpenAI-shaped.
 *
 * Wire facts (LM Studio 0.3.x verified live 2026-07-15; others documented):
 *   /v1/models          → {"object":"list","data":[{"id":...}]} — bare on
 *                         LM Studio; vLLM adds max_model_len per entry;
 *                         Xinference stamps owned_by:"xinference" per entry
 *                         (verified in its restful_api.py source 2026-07-17).
 *   /api/v0/models      → LM Studio enhancement: max_context_length,
 *                         loaded_context_length, state, capabilities
 *                         ["tool_use"], quantization. Used opportunistically.
 *   /props              → llama.cpp server: default_generation_settings
 *                         .n_ctx = the SERVED context. Used opportunistically.
 *
 * Identity routes (documented from official docs/OpenAPI/source 2026-07-17,
 * none probed live here — per-product checks live in identify()):
 *   /info                     → TGI: {model_id, version, sha, …} (its OpenAPI
 *                               spec, which also documents GET /v1/models).
 *   /v1/health                → Lemonade: {status, model_loaded,
 *                               all_models_loaded, …}. Lemonade serves every
 *                               endpoint under bare /v1, /v0, /api/v1 AND
 *                               /api/v0 prefixes (documented) — so it answers
 *                               LM Studio's /api/v0/models route with a valid
 *                               list, and its check must run BEFORE the
 *                               LM Studio check. LM Studio's documented API
 *                               surface (/api/v0/* + OpenAI /v1 routes) lists
 *                               no /v1/health, so the order costs it nothing.
 *                               Lemonade also ships an Ollama-compatible
 *                               surface (documented) — endpoints.ts pins the
 *                               13305 candidate kind:"openai-compat" so the
 *                               first-running ollama probe can't claim the
 *                               box as "Ollama".
 *   /.well-known/localai.json → LocalAI's documented discovery doc (version,
 *                               endpoints, capabilities). Its /version is NOT
 *                               used as identity: vLLM serves /version too.
 *                               LocalAI builds predating the discovery route
 *                               stay generic — no guessing.
 *   /health/liveliness        → LiteLLM proxy: literal "I'm alive!"
 *                               (documented, unauthenticated). With a master
 *                               key set its /v1/models 401s, so detect()
 *                               never admits it — documented skip, not a bug.
 *   llamafile carries NO documented marker of its own: it embeds llama.cpp's
 *   server (llama.cpp is a git submodule of llamafile since 0.10) on the same
 *   documented default 8080, so /props identifies it as llama.cpp
 *   deliberately — a fake discriminator would be dishonest. TGI has no stable
 *   host port (launcher binds container port 80; hosts map it arbitrarily) →
 *   no sweep entry; docker-mapped/manual endpoints still detect + identify.
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

/**
 * Any parsed JSON value, null on any failure. Exists because LiteLLM's
 * documented liveness body is a bare JSON string ("I'm alive!"), which
 * getJson's object contract rejects.
 */
async function getJsonValue(
  url: string,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<unknown> {
  try {
    const r = await fetch(url, {
      redirect: "manual",
      signal: signal ?? AbortSignal.timeout(timeoutMs),
    });
    if (!r.ok) return null;
    return (await r.json()) as unknown;
  } catch {
    return null;
  }
}

async function getJson(
  url: string,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<Record<string, unknown> | null> {
  const data = await getJsonValue(url, timeoutMs, signal);
  return data && typeof data === "object" ? (data as Record<string, unknown>) : null;
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
  // text-generation-webui 5000, KoboldCpp 5001, SGLang 30000, LiteLLM
  // proxy 4000, Xinference 9997, Lemonade 13305 — all documented defaults,
  // not probed live. Lemonade moved 8000 → 13305 in v10.1 (its old default
  // is already swept via vLLM's 8000; 13305 is kind-pinned openai-compat in
  // endpoints.ts because Lemonade speaks Ollama too — see header);
  // LocalAI and llamafile default to
  // 8080 (already swept — llama.cpp's port); TGI gets no entry (no stable
  // host port, see header). 11434 is claimed by the ollama probe first
  // (probe order in probes.ts is load-bearing); Docker Model Runner 12434
  // is a path-prefixed candidate added in endpoints.ts, not a bare port here.
  // Growing this list is discovery-only: agent egress derives from
  // DISCOVERED runtimes (localRuntimeLoopbackPorts), never from these
  // candidates — so common dev ports like 5000 are safe to sweep.
  defaultPorts: [1234, 1337, 4000, 4891, 5000, 5001, 8000, 8080, 9997, 13305, 30000],

  async detect(ep, signal) {
    return listFrom(await getJson(`${base(ep)}/v1/models`, DETECT_TIMEOUT_MS, signal)) !== null;
  },

  async identify(ep, signal) {
    // Docker Model Runner is the only runtime probed under a path prefix
    // (endpoints.ts pins its candidate to .../engines); this endpoint only
    // exists because <base>/v1/models answered — DMR's signature path.
    if (base(ep).endsWith("/engines")) return "Docker Model Runner";
    // Lemonade runs FIRST among the route checks: its documented prefix
    // aliasing (/v1, /v0, /api/v1, /api/v0 all serve every endpoint) makes it
    // answer LM Studio's /api/v0/models route with a valid list, so its own
    // signature must win before the lookalike checks below. Real LM Studio's
    // documented surface has no /v1/health, so this order costs it nothing
    // (header wire facts). Signature keys, not the generic {status:"ok"},
    // are what identify it. All checks here are cheap loopback GETs against
    // a server detect() already proved alive.
    const health = await getJson(`${base(ep)}/v1/health`, DETECT_TIMEOUT_MS, signal);
    if (health && ("model_loaded" in health || "all_models_loaded" in health)) {
      return "Lemonade";
    }
    // With Lemonade screened out, /api/v0/models means LM Studio, and /props
    // default_generation_settings means llama.cpp.
    if (listFrom(await getJson(`${base(ep)}/api/v0/models`, DETECT_TIMEOUT_MS, signal))) {
      return "LM Studio";
    }
    // llamafile lands here too — it embeds llama.cpp's server and has no
    // documented marker of its own (header), so llama.cpp is the honest id.
    const props = await getJson(`${base(ep)}/props`, DETECT_TIMEOUT_MS, signal);
    if (props && "default_generation_settings" in props) return "llama.cpp";
    // TGI: GET /info is in its OpenAPI spec; require both signature keys so
    // a stray {version} route (e.g. vLLM's /version shape) can never match.
    const info = await getJson(`${base(ep)}/info`, DETECT_TIMEOUT_MS, signal);
    if (info && "model_id" in info && "version" in info) {
      return "Text Generation Inference";
    }
    // LocalAI: name-bearing documented discovery doc (header for why not
    // /version). Any JSON object at this well-known URI is LocalAI's.
    if (await getJson(`${base(ep)}/.well-known/localai.json`, DETECT_TIMEOUT_MS, signal)) {
      return "LocalAI";
    }
    // LiteLLM proxy: documented unauthenticated liveness literal.
    if ((await getJsonValue(`${base(ep)}/health/liveliness`, DETECT_TIMEOUT_MS, signal)) === "I'm alive!") {
      return "LiteLLM";
    }
    // Xinference stamps owned_by on every /v1/models entry (source-verified).
    // Re-fetches the detect route, so it goes last; zero running models →
    // empty list → stays generic rather than guessing.
    const entries = listFrom(await getJson(`${base(ep)}/v1/models`, DETECT_TIMEOUT_MS, signal));
    if (entries?.some((m) => (m as { owned_by?: unknown } | null)?.owned_by === "xinference")) {
      return "Xinference";
    }
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

  async certificationIdentity(ep, modelId, signal) {
    const [version, models] = await Promise.all([
      getJson(`${base(ep)}/version`, DETECT_TIMEOUT_MS, signal),
      getJson(`${base(ep)}/v1/models`, LIST_TIMEOUT_MS, signal),
    ]);
    const raw = listFrom(models)?.find((entry) => (
      entry && typeof entry === "object" && (entry as { id?: unknown }).id === modelId
    ));
    const row = raw && typeof raw === "object"
      ? raw as { digest?: unknown; sha?: unknown; model_sha?: unknown; revision?: unknown }
      : null;
    const digest = row?.digest ?? row?.sha ?? row?.model_sha ?? row?.revision;
    return {
      runtimeVersion: typeof version?.version === "string" ? version.version : null,
      modelDigest: typeof digest === "string" ? digest : null,
    };
  },

  chatExtraBody() {
    // No surveyed runtime honors a per-request context-size field on /v1;
    // context is load/launch-time config everywhere. Never ship a no-op param.
    return {};
  },
};
