/**
 * Ollama adapter for the local-runtime seam — the FIRST adapter, not a
 * base class. Speaks Ollama's native API for discovery only; chat stays
 * on the canonical OpenAI-compat adapter.
 *
 * Wire facts (verified live against Ollama 0.32, 2026-07-15):
 *   /api/version → {"version":"..."} — Ollama-specific, used for detect.
 *   /api/tags    → model list with size/modified_at.
 *   /api/show    → capabilities: ["completion","tools",…]; parameters is a
 *                  whitespace-aligned string that may carry "num_ctx N";
 *                  model_info["<arch>.context_length"] is the ARCHITECTURE
 *                  max (e.g. 262144), NOT what's being served — never
 *                  report it as the window.
 *   /api/ps      → context_length of each LOADED model = the real served
 *                  window (e.g. 32768). Ground truth when present.
 *   /v1/chat/completions silently DROPS num_ctx (re-verified live
 *   2026-07-17, Ollama 0.32.0: options.num_ctx 512 then 1024, and
 *   top-level num_ctx 2048, all left /api/ps context_length at the box
 *   default 131072; the sensitivity control — options.num_ctx 512 via
 *   native /api/chat — resized the runner to 512). So chatExtraBody is
 *   {}: LAX reports the real window, it can't resize it on this path.
 *   Deliberate either way: LAX does not SET num_ctx anywhere yet —
 *   per-request ctx sizing is a parked policy decision.
 */
import type {
  LocalModel,
  LocalRuntimeEndpoint,
  LocalRuntimeProbe,
} from "./types.js";

const DETECT_TIMEOUT_MS = 1_500;
const LIST_TIMEOUT_MS = 3_000;
const SHOW_TIMEOUT_MS = 5_000;

function base(ep: LocalRuntimeEndpoint): string {
  return ep.baseUrl.replace(/\/+$/, "");
}

async function getJson(
  url: string,
  timeoutMs: number,
  signal: AbortSignal | undefined,
  init?: RequestInit,
): Promise<Record<string, unknown> | null> {
  try {
    const r = await fetch(url, {
      redirect: "manual",
      signal: signal ?? AbortSignal.timeout(timeoutMs),
      ...init,
    });
    if (!r.ok) return null;
    const data: unknown = await r.json();
    return data && typeof data === "object" ? (data as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/** Parse "num_ctx  8192" out of /api/show's parameters string. */
export function parseNumCtx(parameters: unknown): number | null {
  if (typeof parameters !== "string") return null;
  const m = parameters.match(/^num_ctx\s+(\d+)\s*$/m);
  if (!m) return null;
  const n = Number(m[1]);
  return Number.isInteger(n) && n > 0 ? n : null;
}

/** Tool support from /api/show's capabilities array. Absent array = unknown. */
export function parseToolCapability(capabilities: unknown): boolean | null {
  if (!Array.isArray(capabilities)) return null;
  return capabilities.includes("tools");
}

/**
 * True only when the runtime AUTHORITATIVELY says this model embeds and
 * cannot chat. Used to MARK the model (LocalModel.embeddingOnly), never to
 * drop it at list time — this seam also serves the embedding-settings
 * picker and the boot-time embedding warmer, and dropping here blinded
 * both to every installed embedder (regression 6e27ff0f: the Settings
 * dropdown auto-picked a 65GB chat model as the embedding model). The
 * chat-only filter lives in discovery.ts. Absent/unknown capabilities →
 * false: never flag a model we can't prove is an embedder. (Ollama 0.32's
 * /api/tags carries capabilities per model; older versions omit it and
 * fall through to the downstream name-regex backstop.)
 */
export function isEmbeddingOnly(capabilities: unknown): boolean {
  if (!Array.isArray(capabilities)) return false;
  return capabilities.includes("embedding") && !capabilities.includes("completion");
}

/** The loaded model's served context from /api/ps, or null if not loaded. */
export function parseLoadedContext(ps: unknown, modelId: string): number | null {
  if (!ps || typeof ps !== "object") return null;
  const models = (ps as { models?: unknown }).models;
  if (!Array.isArray(models)) return null;
  for (const m of models) {
    if (!m || typeof m !== "object") continue;
    const row = m as { name?: unknown; model?: unknown; context_length?: unknown };
    if (row.name !== modelId && row.model !== modelId) continue;
    const ctx = Number(row.context_length);
    return Number.isInteger(ctx) && ctx > 0 ? ctx : null;
  }
  return null;
}

export const ollamaProbe: LocalRuntimeProbe = {
  kind: "ollama",
  label: "Ollama",
  defaultPorts: [11434],

  async detect(ep, signal) {
    const data = await getJson(`${base(ep)}/api/version`, DETECT_TIMEOUT_MS, signal);
    return typeof data?.version === "string";
  },

  async listModels(ep, signal) {
    const data = await getJson(`${base(ep)}/api/tags`, LIST_TIMEOUT_MS, signal);
    const models = data?.models;
    if (!Array.isArray(models)) return [];
    const out: LocalModel[] = [];
    for (const m of models) {
      if (!m || typeof m !== "object") continue;
      const row = m as {
        name?: unknown; size?: unknown; modified_at?: unknown; capabilities?: unknown;
      };
      if (typeof row.name !== "string" || row.name.length === 0) continue;
      out.push({
        id: row.name,
        contextWindow: null,
        tools: null,
        ...(isEmbeddingOnly(row.capabilities) ? { embeddingOnly: true } : {}),
        sizeBytes: typeof row.size === "number" ? row.size : undefined,
        modifiedAt: typeof row.modified_at === "string" ? row.modified_at : undefined,
      });
    }
    return out;
  },

  async probeModel(ep, modelId, signal) {
    const [ps, show] = await Promise.all([
      getJson(`${base(ep)}/api/ps`, SHOW_TIMEOUT_MS, signal),
      getJson(`${base(ep)}/api/show`, SHOW_TIMEOUT_MS, signal, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model: modelId }),
      }),
    ]);
    const result: Partial<LocalModel> = {};
    // Precedence: what's actually loaded beats Modelfile config; the
    // architecture max in model_info is deliberately never consulted.
    const loaded = parseLoadedContext(ps, modelId);
    const numCtx = show ? parseNumCtx(show.parameters) : null;
    const window = loaded ?? numCtx;
    if (window !== null) result.contextWindow = window;
    const tools = show ? parseToolCapability(show.capabilities) : null;
    if (tools !== null) result.tools = tools;
    return result;
  },

  async certificationIdentity(ep, modelId, signal) {
    const [version, tags] = await Promise.all([
      getJson(`${base(ep)}/api/version`, DETECT_TIMEOUT_MS, signal),
      getJson(`${base(ep)}/api/tags`, LIST_TIMEOUT_MS, signal),
    ]);
    const models = Array.isArray(tags?.models) ? tags.models : [];
    const entry = models.find((raw) => {
      if (!raw || typeof raw !== "object") return false;
      const row = raw as { name?: unknown; model?: unknown };
      return row.name === modelId || row.model === modelId;
    }) as { digest?: unknown } | undefined;
    return {
      runtimeVersion: typeof version?.version === "string" ? version.version : null,
      modelDigest: typeof entry?.digest === "string" ? entry.digest : null,
    };
  },

  chatExtraBody() {
    return {};
  },
};
